import type { Job } from '@/lib/db/schema';
import { appendEvent } from '@/lib/db/queries/events';
import { listDispatchCandidates, listDispatchedImageIds } from '@/lib/db/queries/dispatch';
import { getEmbedder } from '@/lib/ai';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { loadUserProviderKeys } from '@/lib/ai/keys';
import { getSiteAdminId } from '@/lib/db/queries/users';
import { EVENT_TYPE, SUBJECT_TYPE, dedupeKey } from '@/lib/universe/events';
import type {
  DispatchClaimedPayload,
  DispatchSentPayload,
  DispatchSkippedPayload
} from '@/lib/universe/events';
import {
  BAND_MAX_DISTANCE,
  BAND_MIN_DISTANCE,
  MAX_POOL_CANDIDATES,
  WIDE_BAND_MAX_DISTANCE,
  WIDE_BAND_MIN_DISTANCE,
  captionCharBudget,
  dispatchLiveEnabled
} from '@/lib/dispatch/config';
import { googleTrendsSource, trendText } from '@/lib/dispatch/trends';
import { screenTrends } from '@/lib/dispatch/safety';
import { pickSpecimen } from '@/lib/dispatch/select';
import { generateCaption } from '@/lib/dispatch/caption';
import { driftForDate, utcDateKey } from '@/lib/dispatch/schedule';
import { SKIP_REASON, type SkipReason, type Trend } from '@/lib/dispatch/types';

// The daily outbound dispatch, start to finish. Runs at most once per UTC day and
// never retries: the cron enqueues it with maxAttempts 1, and the day-claim event
// makes a second run structurally impossible even if something else enqueues one.
//
// Every failure path is a logged skip, not a thrown error. The handler only
// throws when it cannot log at all (a dead database), because that is the one
// case where retrying is the right behaviour.
//
// PHASE 1 SCOPE: everything up to and including the assembled post. There is no
// X client yet, so `mode` is always 'dry-run' and postId is always null. The
// live switch and the posting call land in phase 2.

type DispatchPayload = {
  dateKey?: string;
  trigger?: 'cron' | 'manual';
  // A review run claims a distinct slot so it does not consume the real day.
  claimSuffix?: string;
  // Forces dry run regardless of env. Phase 2 honours this alongside the live switch.
  dryRun?: boolean;
};

export async function xDispatchHandler(job: Job): Promise<void> {
  const payload = (job.payload ?? {}) as DispatchPayload;
  const now = new Date();
  const dateKey = payload.dateKey ?? utcDateKey(now);
  const trigger = payload.trigger === 'manual' ? 'manual' : 'cron';
  const slotKey = dedupeKey.dispatchDay(dateKey, payload.claimSuffix);

  // Phase 1 is dry run unconditionally. The env switch is read here so the value
  // recorded on the event is honest about how the deployment is configured, but
  // it cannot produce a live post until phase 2 wires a client.
  const mode: 'dry-run' | 'live' = 'dry-run';
  const liveConfigured = dispatchLiveEnabled() && payload.dryRun !== true;

  // ---- the day-claim. This, not the cron schedule, is the once-per-day cap.
  const claim = await appendEvent({
    type: EVENT_TYPE.DispatchClaimed,
    subjectType: SUBJECT_TYPE.Dispatch,
    subjectId: dateKey,
    payload: { mode, trigger } satisfies DispatchClaimedPayload,
    dedupeKey: slotKey
  });
  if (!claim.inserted) {
    // Someone already owns this slot. Do not log a skip -- the slot already has
    // an outcome, and a second skip row would misreport the day.
    return;
  }

  const skip = async (reason: SkipReason, detail: string, trendTopic: string | null = null) => {
    await appendEvent({
      type: EVENT_TYPE.DispatchSkipped,
      subjectType: SUBJECT_TYPE.Dispatch,
      subjectId: dateKey,
      payload: { mode, reason, detail: detail.slice(0, 500), trendTopic } satisfies DispatchSkippedPayload,
      dedupeKey: dedupeKey.dispatchOutcome(slotKey)
    });
  };

  // ---- 1. trend acquisition -------------------------------------------------
  let trends: Trend[];
  try {
    trends = await googleTrendsSource().fetchTrends();
  } catch (err) {
    await skip(SKIP_REASON.NoTrends, `trend fetch failed: ${errText(err)}`);
    return;
  }
  if (trends.length === 0) {
    await skip(SKIP_REASON.NoTrends, 'trend source returned no items');
    return;
  }

  // ---- 2. safety gate, before anything else runs ----------------------------
  const screened = await screenTrends(trends);
  if (!screened.ok) {
    await skip(SKIP_REASON.ClassifierError, screened.error);
    return;
  }
  if (screened.cleared.length === 0) {
    await skip(
      SKIP_REASON.NoSafeTrend,
      `no candidate cleared the gate (${trends.length} fetched, ${screened.deniedByList} denied by list, ${screened.screened} classified)`
    );
    return;
  }

  // Prefer the most confidently dumb trend: the gate already rejected everything
  // else, so this is a ranking among safe options, not a second safety decision.
  const chosen = screened.cleared[0]!;

  // ---- 3. specimen selection ------------------------------------------------
  const cfg = await loadAiConfig();
  const keys = await loadUserProviderKeys(getSiteAdminId());
  const embedder = getEmbedder(cfg, keys);
  if (!embedder) {
    await skip(SKIP_REASON.NoProviderKey, 'no embeddings key configured', chosen.trend.topic);
    return;
  }

  let vec: number[];
  try {
    vec = await embedder.embed(trendText(chosen.trend));
  } catch (err) {
    await skip(SKIP_REASON.NoSpecimen, `trend embedding failed: ${errText(err)}`, chosen.trend.topic);
    return;
  }

  const excludeImageIds = await listDispatchedImageIds();
  let candidates = await listDispatchCandidates({
    vec,
    minDistance: BAND_MIN_DISTANCE,
    maxDistance: BAND_MAX_DISTANCE,
    limit: MAX_POOL_CANDIDATES,
    excludeImageIds
  });
  // One widening pass. Two would be a loop dressed as a policy.
  if (candidates.length === 0) {
    candidates = await listDispatchCandidates({
      vec,
      minDistance: WIDE_BAND_MIN_DISTANCE,
      maxDistance: WIDE_BAND_MAX_DISTANCE,
      limit: MAX_POOL_CANDIDATES,
      excludeImageIds
    });
  }
  const specimen = pickSpecimen(candidates, { seed: `${dateKey}:${chosen.trend.topic}`, now });
  if (!specimen) {
    await skip(
      SKIP_REASON.NoSpecimen,
      'no embedded specimen fell in the similarity band',
      chosen.trend.topic
    );
    return;
  }

  // ---- 4. caption -----------------------------------------------------------
  const drift = driftForDate(dateKey);
  const caption = await generateCaption({
    trend: chosen.trend,
    specimen,
    charBudget: captionCharBudget(),
    drift
  });
  if (!caption.ok) {
    await skip(SKIP_REASON.GenerationFailed, caption.reason, chosen.trend.topic);
    return;
  }

  // ---- 5. dispatch ----------------------------------------------------------
  // Phase 2 posts here when `liveConfigured` is true and credentials resolve.
  // Until then the assembled post IS the deliverable: it goes on the event log
  // in full and is reviewed at /admin/dispatch.
  const sent: DispatchSentPayload = {
    mode,
    imageId: specimen.imageId,
    slug: specimen.slug,
    handle: specimen.handle,
    blobUrl: specimen.blobUrl,
    isNsfw: specimen.isNsfw,
    caption: caption.caption,
    hashtags: caption.hashtags,
    drift,
    trendTopic: chosen.trend.topic,
    trendSource: chosen.trend.source,
    trendHeadlines: chosen.trend.headlines.map((h) => h.title),
    safetyCategory: chosen.verdict.category,
    safetyConfidence: chosen.verdict.confidence,
    safetyReason: chosen.verdict.reason,
    distance: specimen.distance,
    model: caption.model,
    postId: null
  };
  await appendEvent({
    type: EVENT_TYPE.DispatchSent,
    subjectType: SUBJECT_TYPE.Dispatch,
    subjectId: dateKey,
    payload: { ...sent, liveConfigured },
    dedupeKey: dedupeKey.dispatchOutcome(slotKey)
  });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
