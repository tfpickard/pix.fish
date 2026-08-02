import type { Job } from '@/lib/db/schema';
import type { JobContext } from '@/lib/jobs/worker';
import { appendEvent } from '@/lib/db/queries/events';
import {
  currentPostState,
  definiteFailureGeneration,
  listDispatchCandidates,
  listDispatchedImageIds
} from '@/lib/db/queries/dispatch';
import { getDispatchEmbedder } from '@/lib/ai/dispatch-embed';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { loadUserProviderKeys } from '@/lib/ai/keys';
import { getSiteAdminId } from '@/lib/db/queries/users';
import { EVENT_TYPE, SUBJECT_TYPE, dedupeKey } from '@/lib/universe/events';
import type {
  DispatchAttemptedPayload,
  DispatchClaimedPayload,
  DispatchSentPayload,
  DispatchSkippedPayload
} from '@/lib/universe/events';
import {
  BAND_MAX_DISTANCE,
  BAND_MIN_DISTANCE,
  DRIFT_ENABLED,
  EMBED_TIMEOUT_MS,
  MAX_POOL_CANDIDATES,
  WIDE_BAND_MAX_DISTANCE,
  WIDE_BAND_MIN_DISTANCE,
  IMAGE_FETCH_TIMEOUT_MS,
  LIVE_ALLOW_NSFW,
  LIVE_STILL_MIMES,
  liveEligible,
  POST_PHASE_BUDGET_MS,
  POST_ONLY_BUDGET_MS,
  PIPELINE_BUDGET_MS,
  WORKER_JOB_TIMEOUT_MS,
  canFinishPostPhase,
  canStartPipeline,
  canStartPostPhase,
  captionCharBudget,
  dispatchLiveEnabled,
  madeWithAiFlag
} from '@/lib/dispatch/config';
import { createPost, fetchSpecimenImage, getXCredentials, uploadMedia } from '@/lib/dispatch/x-client';
import { googleTrendsSource, trendText } from '@/lib/dispatch/trends';
import { screenTrends } from '@/lib/dispatch/safety';
import { pickSpecimen } from '@/lib/dispatch/select';
import { generateCaption } from '@/lib/dispatch/caption';
import { driftForDate, utcDateKey } from '@/lib/dispatch/schedule';
import { SKIP_REASON, type SkipReason, type SpecimenCandidate, type Trend } from '@/lib/dispatch/types';

// The outbound dispatch, start to finish. Never retries: every enqueue uses
// maxAttempts 1, and the day-claim event makes a second run on the same slot
// structurally impossible even if something else enqueues one.
//
// "At most once per UTC day" binds the SCHEDULED dispatch specifically. Cron
// enqueues with no claimSuffix, so every scheduled run competes for the one
// `x.dispatch:<date>` slot. Manual runs from /admin/dispatch pass a
// `manual:<ms>` suffix and are therefore uncapped by design -- an admin posting
// several times in a day is a decision, whereas a scheduler doing it is a bug.
// A manual LIVE post additionally cancels that day's scheduled run, which the
// cron route enforces by looking for the attempt event.
//
// Every failure path is a logged skip, not a thrown error. The handler only
// throws when it cannot log at all (a dead database), because that is the one
// case where retrying is the right behaviour.
//
// Dry run is the default and stays the default: `mode` is only 'live' when the
// X_DISPATCH_LIVE switch is on, credentials resolve, and the job was not queued
// with dryRun. Everything up to the post is identical in both modes, so a dry run
// exercises the whole pipeline.

type DispatchPayload = {
  dateKey?: string;
  trigger?: 'cron' | 'manual';
  // A review run claims a distinct slot so it does not consume the real day.
  claimSuffix?: string;
  // Forces dry run regardless of env. Honoured alongside the live switch.
  dryRun?: boolean;
  // Set when an admin explicitly asked for a live post. Carried through the queue
  // so the handler can tell "nobody asked to post" (degrade to dry, correct) from
  // "someone asked and we cannot" (refuse and say so).
  requestedLive?: boolean;
};

export async function xDispatchHandler(job: Job, ctx: JobContext): Promise<void> {
  const payload = (job.payload ?? {}) as DispatchPayload;
  const now = new Date();
  // The earliest thing that can stop this work. Two clocks can: this handler's
  // own per-job timeout, and the enclosing cron invocation -- which runs several
  // jobs sequentially and may already be nearly spent. Taking the minimum is the
  // whole point; measuring against the handler alone would let a post start with
  // the function about to be terminated.
  const postDeadlineAt = Math.min(Date.now() + WORKER_JOB_TIMEOUT_MS, ctx.invocationDeadlineAt);
  const trigger = payload.trigger === 'manual' ? 'manual' : 'cron';

  // Claim the EXECUTION date, not the date stamped at enqueue. A job queued at
  // 23:5x and drained after midnight would otherwise claim yesterday's slot,
  // leaving today unclaimed -- so the next cron tick enqueues today as well and
  // the account posts twice inside one UTC day, defeating the guarantee this
  // whole design rests on. Claiming by execution date keeps "one claim per UTC
  // day" true regardless of queue latency: the late job takes today's slot, and
  // today's tick then finds it taken.
  //
  // payload.dateKey is therefore advisory. It still drives the drift variant and
  // the selection seed so a deliberate replay of a given day reproduces, but it
  // never decides which day is being consumed.
  const dateKey = utcDateKey(now);
  const seedKey = payload.dateKey ?? dateKey;
  const slotKey = dedupeKey.dispatchDay(dateKey, payload.claimSuffix);

  // Selection is seeded per SLOT, not per day. Seeding on the date alone meant
  // two runs sharing a date and a trend drew the same specimen deterministically
  // -- every overlap a duplicate, by construction rather than by bad luck.
  //
  // This is a mitigation, NOT the safety property, and the distinction matters:
  // distinct seeds make a collision unlikely, not impossible. Weighted draws over
  // a large pool can still coincide, and when the eligible pool holds exactly one
  // row both seeds must return it -- precisely the case where the pool is tight
  // and the stakes are highest. The actual mutual exclusion is the attempt event
  // further down, whose dedupe key is the specimen; this only keeps runs from
  // walking the corpus in lockstep, and makes repeated manual runs varied.
  //
  // The drift predicate deliberately keeps using seedKey: drift is a property of
  // the day, not of the run, and a replay of a given date must reproduce it.
  const selectionSeed = payload.claimSuffix ? `${seedKey}:${payload.claimSuffix}` : seedKey;

  // Live requires all three: the env switch, a job that did not ask for a dry
  // run, and credentials actually present. Missing credentials degrade to a dry
  // run rather than to a failure -- a deployment with the switch on but no keys
  // should still produce a reviewable draft, not a claimed day with nothing on it.
  const liveConfigured =
    dispatchLiveEnabled() && payload.dryRun !== true && getXCredentials() !== null;
  const mode: 'dry-run' | 'live' = liveConfigured ? 'live' : 'dry-run';

  // Do not CLAIM a day this invocation has no time to finish.
  //
  // The claim is what makes a day un-runnable a second time, and the cron
  // declines to re-enqueue a claimed day. So a handler that claims and is then
  // terminated before writing an outcome leaves that day permanently claimed
  // with nothing on the log -- the silent no-post day this design exists to
  // prevent, reached without a single thing going wrong except starting late.
  // The drain runs jobs sequentially inside one 60s function, so starting with
  // most of it already spent is ordinary, not exceptional.
  //
  // The existing budget checks all sit in the POST phase, which is far too late:
  // they protect the side effect, not the claim, and a dry run never reaches
  // them at all. Declining BEFORE the claim is what keeps the day recoverable --
  // it stays unclaimed, so the next tick simply runs it.
  //
  // Throwing rather than returning quietly: the day is intact either way, but a
  // failed job row is visible at /admin/jobs, and "the invocation had no room
  // for me" is exactly what a failed job should mean. maxAttempts is 1, so this
  // does not retry.
  if (!canStartPipeline(postDeadlineAt)) {
    throw new Error(
      `declined before claiming ${dateKey}: ${postDeadlineAt - Date.now()}ms left in the invocation, ${PIPELINE_BUDGET_MS}ms needed to reach an outcome`
    );
  }

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

  // The gate above was taken BEFORE the claim write, which is a database round
  // trip of unknown duration. A run that passed with a slim margin can arrive
  // here with the margin gone -- and now the day is committed, so returning
  // quietly would leave exactly the claimed-with-no-outcome day the gate exists
  // to prevent.
  //
  // Recording a skip is the recovery, not returning: the day is spent either way,
  // and a spent day with a reason on the log is an operator's problem to read
  // rather than a silent gap. The skip write is one insert, which is the smallest
  // thing that can still be done here.
  const budgetLostAfterClaim = !canStartPipeline(postDeadlineAt);

  const skip = async (reason: SkipReason, detail: string, trendTopic: string | null = null) => {
    await appendEvent({
      type: EVENT_TYPE.DispatchSkipped,
      subjectType: SUBJECT_TYPE.Dispatch,
      subjectId: dateKey,
      payload: {
        slotKey,
        mode,
        trigger,
        reason,
        detail: detail.slice(0, 500),
        trendTopic
      } satisfies DispatchSkippedPayload,
      dedupeKey: dedupeKey.dispatchOutcome(slotKey)
    });
  };

  if (budgetLostAfterClaim) {
    await skip(
      SKIP_REASON.InternalError,
      `budget ran out while claiming ${dateKey}: ${postDeadlineAt - Date.now()}ms left, ${PIPELINE_BUDGET_MS}ms needed`
    );
    return;
  }

  // An explicit live request that can no longer post is refused, not downgraded.
  // The admin endpoint validated the switch and the credentials before queuing,
  // but a deployment or a credential rotation can land in between, and by then
  // the operator has been told a LIVE job is queued. Filing a draft under that
  // promise is the same class of mistake as the review button reporting success
  // while doing nothing: the surface says posted, the account says otherwise.
  if (payload.requestedLive === true && !liveConfigured) {
    await skip(
      SKIP_REASON.LiveUnavailable,
      `live was requested but the deployment cannot post now (switch ${dispatchLiveEnabled() ? 'on' : 'off'}, credentials ${getXCredentials() ? 'present' : 'missing'})`
    );
    return;
  }

  // Everything past the claim runs inside this guard. The claim is what makes a
  // day un-runnable a second time, so a throw between here and the outcome event
  // would leave the day claimed with nothing on the log to explain it, and the
  // cron would decline to re-enqueue -- a silent no-post day, which is the one
  // outcome this feature must never produce quietly.
  //
  // The individual stages below still catch their own expected failures and give
  // them precise reason codes. This is only the backstop for the unexpected: a
  // transient DB read in the candidate queries or in getPromptByKey, a missing
  // OWNER_GITHUB_ID, a provider that cannot embed.
  try {
    await runDispatch({ dateKey, seedKey, selectionSeed, slotKey, mode, trigger, liveConfigured, postDeadlineAt, skip });
  } catch (err) {
    // Fail closed, but audibly. If the skip write ALSO throws we genuinely
    // cannot record anything, and that is the one case where letting the job
    // fail is right -- the queue surfaces it at /admin/jobs.
    await skip(SKIP_REASON.InternalError, `unhandled failure: ${errText(err)}`);
  }
}

// The pipeline proper. Split out so the handler above can wrap the whole thing in
// one guard; `skip` is injected because it closes over the claim's slot key.
async function runDispatch(ctx: {
  dateKey: string;
  // Drives the drift variant and the selection seed; equals dateKey unless a
  // replay explicitly asked for another day. Never used for the claim.
  seedKey: string;
  // Seeded per slot so concurrent runs cannot draw the same specimen.
  selectionSeed: string;
  slotKey: string;
  mode: 'dry-run' | 'live';
  trigger: 'cron' | 'manual';
  liveConfigured: boolean;
  postDeadlineAt: number;
  skip: (reason: SkipReason, detail: string, trendTopic?: string | null) => Promise<void>;
}): Promise<void> {
  const { dateKey, seedKey, selectionSeed, slotKey, mode, trigger, liveConfigured, postDeadlineAt, skip } = ctx;
  const now = new Date();

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
      `no candidate cleared the gate (${trends.length} fetched, ${screened.deniedByList} denied by list, ${screened.deniedNoContext} dropped for no headlines, ${screened.screened} classified)`
    );
    return;
  }

  // Prefer the most confidently dumb trend: the gate already rejected everything
  // else, so this is a ranking among safe options, not a second safety decision.
  const chosen = screened.cleared[0]!;

  // ---- 3. specimen selection ------------------------------------------------
  const cfg = await loadAiConfig();
  const keys = await loadUserProviderKeys(getSiteAdminId());
  // Not getEmbedder(): that path's client retries a 429 or 5xx twice by default,
  // and racing it against a deadline does not cancel those attempts -- the job
  // would file its skip while the retries continued underneath. getDispatchEmbedder
  // disables retries and takes a real abort signal. It also returns null instead
  // of throwing when embeddings are routed to a provider with no embed(), which
  // the admin UI permits.
  const embedder = getDispatchEmbedder(cfg, keys);
  if (!embedder) {
    await skip(
      SKIP_REASON.NoProviderKey,
      'no usable embeddings provider or key for dispatch',
      chosen.trend.topic
    );
    return;
  }

  let vec: number[];
  try {
    // The embedder cancels itself at the deadline; this wrapper stays as the
    // guarantee that control returns here regardless, in time to file an outcome.
    // A throw after the claim with nothing logged is the one failure this handler
    // must never produce.
    vec = await withDeadline(
      embedder.embed(trendText(chosen.trend), EMBED_TIMEOUT_MS),
      EMBED_TIMEOUT_MS,
      'trend embedding'
    );
  } catch (err) {
    await skip(SKIP_REASON.NoSpecimen, `trend embedding failed: ${errText(err)}`, chosen.trend.topic);
    return;
  }

  const excludeImageIds = await listDispatchedImageIds();
  // Only rows embedded by the same provider/model are comparable to `vec`.
  let candidates = await listDispatchCandidates({
    vec,
    embedProvider: embedder.name,
    embedModel: embedder.model,
    sampleSeed: `${selectionSeed}:${chosen.trend.topic}`,
    minDistance: BAND_MIN_DISTANCE,
    maxDistance: BAND_MAX_DISTANCE,
    limit: MAX_POOL_CANDIDATES,
    excludeImageIds,
    liveOnly: liveConfigured
  });
  // Live mode drops NSFW rows (see below). The widening decision has to be made
  // on what is actually SELECTABLE, not on the raw count -- a narrow band holding
  // three NSFW rows is empty for a live run, and testing the raw count there
  // skipped the widening pass and reported no_specimen while usable specimens sat
  // in the wide band.
  const selectable = (rows: SpecimenCandidate[]) =>
    liveConfigured ? rows.filter(liveEligible) : rows;

  // One widening pass. Two would be a loop dressed as a policy.
  if (selectable(candidates).length === 0) {
    candidates = await listDispatchCandidates({
      vec,
      embedProvider: embedder.name,
      embedModel: embedder.model,
      sampleSeed: `${selectionSeed}:${chosen.trend.topic}`,
      minDistance: WIDE_BAND_MIN_DISTANCE,
      maxDistance: WIDE_BAND_MAX_DISTANCE,
      limit: MAX_POOL_CANDIDATES,
      excludeImageIds,
      liveOnly: liveConfigured
    });
  }
  // NSFW rows stay in the band for dry runs and for selection generally -- that
  // was a deliberate product call. They are filtered only for a LIVE post, and
  // only because X API v2 dropped the per-post sensitivity flag that v1.1 had:
  // there is no way to mark an individual post as sensitive at post time, so an
  // unflagged NSFW post would put the account itself at risk. Filtering here
  // rather than at the post call means the day picks another specimen instead of
  // being spent on a skip.
  const eligible = selectable(candidates);
  const specimen = pickSpecimen(eligible, { seed: `${selectionSeed}:${chosen.trend.topic}`, now });
  if (!specimen) {
    // Say which of the two emptied the pool. "Nothing in the band" and "the band
    // held only NSFW rows on a live day" call for completely different responses
    // -- widen the band, or reconsider LIVE_ALLOW_NSFW -- and the event log is
    // the only place that distinction survives. Reporting the band for an
    // NSFW-filtered day would send a reader after a corpus problem that is not
    // there, on precisely the days this filter is doing something.
    const filteredOut = candidates.length - eligible.length;
    await skip(
      SKIP_REASON.NoSpecimen,
      eligible.length === 0 && filteredOut > 0
        ? `all ${filteredOut} specimen(s) in the band are ineligible for live posting (NSFW, unclassified, or GIF)`
        : 'no embedded specimen fell in the similarity band',
      chosen.trend.topic
    );
    return;
  }

  // ---- 4. caption -----------------------------------------------------------
  // driftForDate stays the pure "would today drift" predicate; DRIFT_ENABLED is
  // the shipping decision. See config.ts for why the variant is currently off --
  // in short, it produces on-topic commentary, which is the one outcome worse
  // than not posting.
  const drift = DRIFT_ENABLED && driftForDate(seedKey);
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
  // In dry run the assembled post IS the deliverable: it goes on the event log
  // in full and is reviewed at /admin/dispatch. Live mode posts it first and
  // records the resulting id alongside.
  let postId: string | null = null;
  let postUrl: string | null = null;
  if (liveConfigured) {
    // Do not START a post there is not time to finish AND record. The worst case
    // upstream (32s) plus this phase (31s) exceeds the worker's 50s timeout, and
    // the cron function itself dies at 60s, so no timeout value makes the sum
    // safe. Checking the clock does: a day skipped because the upstream ran slow
    // costs one post, whereas a post landing as the job is killed leaves a public
    // post with no outcome on the log.
    if (!canStartPostPhase(postDeadlineAt)) {
      await skip(
        SKIP_REASON.PostFailed,
        `not enough budget left to post safely: ${postDeadlineAt - Date.now()}ms to deadline, ${POST_PHASE_BUDGET_MS}ms needed`,
        chosen.trend.topic
      );
      return;
    }

    // Fetch and upload FIRST. Neither can publish anything, so a blob 404 or an
    // oversized image must not retire the specimen -- it is still perfectly good
    // for another day.
    const media = await prepareMedia(specimen);
    if (!media.ok) {
      await skip(SKIP_REASON.PostFailed, media.reason, chosen.trend.topic);
      return;
    }

    // Re-check the clock. The gate above was taken before an image fetch, an
    // upload, and (below) a database write, none of which are instant; a stale
    // "yes" is exactly how a post lands after the worker has already given up on
    // the job.
    //
    // canFinishPostPhase, not canStartPostPhase: the fetch and upload are done,
    // so requiring their budget again would decline runs that have ample time for
    // the work that actually remains.
    if (!canFinishPostPhase(postDeadlineAt)) {
      await skip(
        SKIP_REASON.PostFailed,
        `budget exhausted after media upload: ${postDeadlineAt - Date.now()}ms to deadline, ${POST_ONLY_BUDGET_MS}ms needed`,
        chosen.trend.topic
      );
      return;
    }

    // Last look at the image itself. Selection read its archived/basement state
    // tens of seconds ago, before a caption call and a media upload; an admin can
    // archive an image inside that window and archiving leaves the blob intact,
    // so nothing else here would notice. The query layer treats archived and
    // basement rows as never-publishable, and that invariant has to hold at the
    // moment of publishing, not merely at the moment of choosing.
    const current = await currentPostState(specimen.imageId);
    if (!current || current.gated || !liveEligible(current)) {
      await skip(
        SKIP_REASON.PostFailed,
        !current
          ? `specimen ${specimen.imageId} no longer exists`
          : `specimen ${specimen.imageId} stopped being postable after selection (gated=${current.gated}, nsfw=${current.isNsfw}, source=${current.nsfwSource})`,
        chosen.trend.topic
      );
      return;
    }

    // A run that started before midnight can arrive here after it. The claim was
    // written against the date at START, so posting now would publish into a day
    // this run never claimed -- and that day's own scheduled dispatch will still
    // fire hours later, putting two automatic posts inside one UTC day. The
    // guarantee is about the day the post LANDS in, and this is the last moment
    // that day is still knowable.
    //
    // Scheduled runs only. Manual dispatches are deliberately uncapped, so a
    // manual run crossing midnight breaks nothing: there is no per-day budget for
    // it to overspend.
    if (trigger === 'cron' && utcDateKey(new Date()) !== dateKey) {
      await skip(
        SKIP_REASON.PostFailed,
        `crossed into ${utcDateKey(new Date())} while preparing ${dateKey}'s dispatch; that day gets its own run`,
        chosen.trend.topic
      );
      return;
    }

    // Claim the specimen immediately before the ONE call that can make something
    // public. This marker does two jobs, and the second is the load-bearing one.
    //
    // First: if the post succeeds and the dispatch.sent write below then fails,
    // only this row stops the same specimen going out again.
    //
    // Second, and the reason it is keyed on the image rather than the slot: it is
    // the mutual exclusion for concurrent runs. Everything upstream -- the
    // enqueue guards, the per-slot selection seed -- makes a collision unlikely
    // without making it impossible, and with a single eligible candidate the seed
    // cannot help at all, since both runs must draw the one row. The unique index
    // on dedupe_key is the only true lock here, so whoever inserts wins and the
    // loser stops before posting.
    const generation = await definiteFailureGeneration(specimen.imageId);
    const attempt = await appendEvent({
      type: EVENT_TYPE.DispatchAttempted,
      subjectType: SUBJECT_TYPE.Dispatch,
      subjectId: dateKey,
      payload: {
        slotKey,
        trigger,
        imageId: specimen.imageId,
        slug: specimen.slug
      } satisfies DispatchAttemptedPayload,
      dedupeKey: dedupeKey.dispatchAttempt(specimen.imageId, generation)
    });
    if (!attempt.inserted) {
      // Another run holds this specimen. Stop here rather than posting: it may
      // already be public, and a duplicate is the one outcome worse than a
      // skipped day.
      await skip(
        SKIP_REASON.PostFailed,
        `specimen ${specimen.imageId} was claimed by a concurrent dispatch`,
        chosen.trend.topic
      );
      return;
    }

    // Re-read the image one last time, AFTER the lock. The check above ran before
    // two database round trips (the generation count and the attempt write), and
    // an archive or an nsfw.scan landing inside that window would otherwise reach
    // X: the earlier verdict is stale the moment anything blocking follows it.
    //
    // The lock is what makes this the authoritative check rather than a repeat of
    // the first. Before the lock the answer could still change under us; after it,
    // nothing else can take this specimen, so what we read here is what we post.
    //
    // Filed as post_failed, which is definite and therefore RELEASES the specimen
    // -- correct, because nothing was published and the image is fine, it simply
    // stopped being postable. The generation bump lets it be tried again later.
    const atPost = await currentPostState(specimen.imageId);
    if (!atPost || atPost.gated || !liveEligible(atPost)) {
      await skip(
        SKIP_REASON.PostFailed,
        !atPost
          ? `specimen ${specimen.imageId} was deleted between the lock and the post`
          : `specimen ${specimen.imageId} stopped being postable between the lock and the post (gated=${atPost.gated}, nsfw=${atPost.isNsfw}, source=${atPost.nsfwSource}, mime=${atPost.mime})`,
        chosen.trend.topic
      );
      return;
    }

    const creds = getXCredentials();
    if (!creds) {
      await skip(SKIP_REASON.PostFailed, 'X credentials disappeared mid-run', chosen.trend.topic);
      return;
    }
    const posted = await createPost(creds, {
      text: caption.caption,
      mediaId: media.mediaId,
      madeWithAi: madeWithAiFlag()
    });
    if (!posted.ok) {
      // Never a retry: a retry that succeeds after a timeout has already posted.
      // But do not claim "no post" when we do not know -- an indeterminate
      // outcome gets its own reason so the log stays honest and an operator knows
      // to check the account.
      await skip(
        posted.indeterminate ? SKIP_REASON.PostIndeterminate : SKIP_REASON.PostFailed,
        posted.reason,
        chosen.trend.topic
      );
      return;
    }
    postId = posted.postId;
    postUrl = posted.url;
  }

  const sent: DispatchSentPayload = {
    slotKey,
    mode,
    trigger,
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
    postId,
    postUrl
  };
  try {
    await appendEvent({
      type: EVENT_TYPE.DispatchSent,
      subjectType: SUBJECT_TYPE.Dispatch,
      subjectId: dateKey,
      payload: { ...sent, liveConfigured },
      dedupeKey: dedupeKey.dispatchOutcome(slotKey)
    });
  } catch (err) {
    // The post is already public and we cannot record it. Falling through to the
    // outer catch would file an internal_error, which the review page renders as
    // "no post" -- the audit surface flatly denying something that exists. Try
    // once to file the honest outcome instead, carrying the post id so the
    // account can be reconciled. If THIS write fails too the database is gone and
    // the outer catch is the right place to end up; the attempt row written
    // before the post is then the only trace, which is why the page shows those.
    if (postId) {
      await skip(
        SKIP_REASON.PostIndeterminate,
        `posted ${postId} but recording it failed: ${errText(err)}`,
        chosen.trend.topic
      );
      return;
    }
    throw err;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Reject after `ms` regardless of what the underlying promise does. The dangling
// work is harmless -- the function instance ends with the job -- and returning
// control on time is what lets the handler record an outcome.
function withDeadline<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

// Everything needed before the post, and nothing that can publish: fetch the
// specimen image and upload it, returning a media id. Kept separate from
// createPost so the caller can put the attempt marker between them -- a blob 404
// or an oversized image must not retire a specimen that never reached X.
//
// Every failure returns a reason string the caller turns into a definite
// `post_failed`; nothing here is ambiguous, because nothing here is public.
//
// The image is fetched from the blob URL rather than passed through from
// selection because the handler never holds the bytes -- selection deals in
// rows, and holding a 5MB buffer across the caption call would be wasted
// residency on the days that end in a skip before ever reaching here.
async function prepareMedia(
  specimen: SpecimenCandidate
): Promise<{ ok: true; mediaId: string } | { ok: false; reason: string }> {
  const creds = getXCredentials();
  if (!creds) return { ok: false, reason: 'X credentials are not configured' };

  const image = await fetchSpecimenImage(specimen.blobUrl, IMAGE_FETCH_TIMEOUT_MS);
  if (!image.ok) return { ok: false, reason: image.reason };

  // Trust the bytes over the row. images.mime is metadata recorded at upload and
  // can be absent, stale, or simply wrong, whereas this is what the blob store
  // just served. Selection filters on the column because that is all a query can
  // see; this is the first point where the actual type is known, and it is still
  // before anything is uploaded.
  if (!LIVE_STILL_MIMES.has(image.mime.toLowerCase())) {
    return {
      ok: false,
      reason: `specimen served ${image.mime}, which is not a postable still image`
    };
  }

  return uploadMedia(creds, image.bytes, image.mime);
}
