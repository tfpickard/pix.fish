import type { Job } from '@/lib/db/schema';
import type { JobContext } from '@/lib/jobs/worker';
import { appendEvent, getEvent } from '@/lib/db/queries/events';
import { currentPostState, definiteFailureGeneration } from '@/lib/db/queries/dispatch';
import { EVENT_TYPE, SUBJECT_TYPE, dedupeKey } from '@/lib/universe/events';
import type {
  DispatchApprovedPayload,
  DispatchAttemptedPayload,
  DispatchSentPayload,
  DispatchSkippedPayload
} from '@/lib/universe/events';
import {
  IMAGE_FETCH_TIMEOUT_MS,
  LIVE_STILL_MIMES,
  POST_ONLY_BUDGET_MS,
  POST_PHASE_BUDGET_MS,
  WORKER_JOB_TIMEOUT_MS,
  canFinishPostPhase,
  canStartPostPhase,
  dispatchLiveEnabled,
  liveEligible,
  madeWithAiFlag
} from '@/lib/dispatch/config';
import { createPost, fetchSpecimenImage, getXCredentials, uploadMedia } from '@/lib/dispatch/x-client';
import { SKIP_REASON, type SkipReason } from '@/lib/dispatch/types';

/**
 * Publish a draft an admin has approved.
 *
 * This exists so a manual dispatch can be READ before it is public. The review
 * run already produces the whole artifact -- trend, specimen, caption, safety
 * verdict -- and files it as a dry-run `dispatch.sent`; this job takes one such
 * draft and puts exactly it on the account.
 *
 * "Exactly it" is the entire point and the reason this is not simply a live
 * re-run. Regenerating would call the model again and produce a different
 * caption, so the thing published would not be the thing approved, and the
 * review would be theatre. Nothing here touches the trend source, the safety
 * classifier or the caption model: the text posted is the text on the draft,
 * verbatim.
 *
 * What it DOES re-check is everything that can change between writing a draft
 * and publishing it: whether the deployment can still post, whether the specimen
 * is still publishable, whether another run has already claimed that specimen,
 * and whether there is time to post and record the outcome. A draft is a
 * proposal, not a permit.
 *
 * The scheduled dispatch is unaffected. Cron still posts without approval,
 * because nobody is watching at a randomized minute and a dispatch nobody
 * approves is a dispatch that never happens.
 */

type PublishPayload = { draftEventId?: number };

export async function xDispatchPublishHandler(job: Job, ctx: JobContext): Promise<void> {
  const payload = (job.payload ?? {}) as PublishPayload;
  const draftEventId = Number(payload.draftEventId);
  if (!Number.isFinite(draftEventId)) throw new Error('x.dispatch.publish requires draftEventId');

  const postDeadlineAt = Math.min(Date.now() + WORKER_JOB_TIMEOUT_MS, ctx.invocationDeadlineAt);

  const draft = await getEvent(draftEventId);
  if (!draft || draft.type !== EVENT_TYPE.DispatchSent) {
    throw new Error(`event ${draftEventId} is not a dispatch draft`);
  }
  const d = draft.payload as unknown as DispatchSentPayload;
  if (d.postId) {
    // Already published. Not an error and not a skip -- the log already says
    // what happened to this draft, and a second outcome row would misreport it.
    return;
  }

  const dateKey = draft.subjectId;
  const slotKey = d.slotKey;

  // ---- the approval claim. This, not the button, is what makes approval single
  // use: a double click, a retried enqueue, or two admins on the same page all
  // collapse here.
  const approval = await appendEvent({
    type: EVENT_TYPE.DispatchApproved,
    subjectType: SUBJECT_TYPE.Dispatch,
    subjectId: dateKey,
    payload: {
      draftEventId,
      slotKey,
      imageId: d.imageId,
      slug: d.slug
    } satisfies DispatchApprovedPayload,
    dedupeKey: dedupeKey.dispatchApproval(draftEventId)
  });
  if (!approval.inserted) return;

  // Outcomes for a published draft are keyed off the DRAFT, not the original
  // slot: that slot already has an outcome (the draft itself), and reusing it
  // would collide and leave the publication unrecorded.
  const outcomeKey = `x.dispatch.publish:${draftEventId}`;
  const skip = async (reason: SkipReason, detail: string) => {
    await appendEvent({
      type: EVENT_TYPE.DispatchSkipped,
      subjectType: SUBJECT_TYPE.Dispatch,
      subjectId: dateKey,
      payload: {
        slotKey,
        mode: 'live',
        trigger: 'manual',
        reason,
        detail: detail.slice(0, 500),
        trendTopic: d.trendTopic ?? null
      } satisfies DispatchSkippedPayload,
      dedupeKey: outcomeKey
    });
  };

  try {
    // Live capability is checked HERE, not at approval time. The admin route
    // checks it too, but that answer is minutes stale by the time this drains
    // and a deployment can land in between.
    if (!dispatchLiveEnabled() || !getXCredentials()) {
      await skip(
        SKIP_REASON.LiveUnavailable,
        `approved draft ${draftEventId} could not be posted: switch ${dispatchLiveEnabled() ? 'on' : 'off'}, credentials ${getXCredentials() ? 'present' : 'missing'}`
      );
      return;
    }

    if (!canStartPostPhase(postDeadlineAt)) {
      await skip(
        SKIP_REASON.PostFailed,
        `not enough budget to publish draft ${draftEventId}: ${postDeadlineAt - Date.now()}ms to deadline, ${POST_PHASE_BUDGET_MS}ms needed`
      );
      return;
    }

    // The specimen may have been archived, reclassified, or deleted since the
    // draft was written -- drafts can sit for a while, which is the point of
    // them, so this window is wide rather than incidental.
    const state = await currentPostState(d.imageId);
    if (!state || state.gated || !liveEligible(state)) {
      await skip(
        SKIP_REASON.PostFailed,
        !state
          ? `specimen ${d.imageId} no longer exists`
          : `specimen ${d.imageId} is no longer publishable (gated=${state.gated}, nsfw=${state.isNsfw}, source=${state.nsfwSource}, mime=${state.mime})`
      );
      return;
    }

    const media = await prepareMedia(d.blobUrl);
    if (!media.ok) {
      await skip(SKIP_REASON.PostFailed, media.reason);
      return;
    }

    if (!canFinishPostPhase(postDeadlineAt)) {
      await skip(
        SKIP_REASON.PostFailed,
        `budget exhausted after media upload: ${postDeadlineAt - Date.now()}ms to deadline, ${POST_ONLY_BUDGET_MS}ms needed`
      );
      return;
    }

    // The same specimen lock the scheduled path uses, for the same reason: a
    // cron run and an approval can want the same image, and the unique index is
    // what decides. Approval does not exempt a draft from that.
    const generation = await definiteFailureGeneration(d.imageId);
    const attempt = await appendEvent({
      type: EVENT_TYPE.DispatchAttempted,
      subjectType: SUBJECT_TYPE.Dispatch,
      subjectId: dateKey,
      payload: {
        slotKey,
        trigger: 'manual',
        imageId: d.imageId,
        slug: d.slug
      } satisfies DispatchAttemptedPayload,
      dedupeKey: dedupeKey.dispatchAttempt(d.imageId, generation)
    });
    if (!attempt.inserted) {
      await skip(SKIP_REASON.PostFailed, `specimen ${d.imageId} was claimed by another dispatch`);
      return;
    }

    // Authoritative re-read, after the lock. See the equivalent in xDispatch.ts.
    const atPost = await currentPostState(d.imageId);
    if (!atPost || atPost.gated || !liveEligible(atPost)) {
      await skip(
        SKIP_REASON.PostFailed,
        `specimen ${d.imageId} stopped being publishable between the lock and the post`
      );
      return;
    }

    const creds = getXCredentials();
    if (!creds) {
      await skip(SKIP_REASON.PostFailed, 'X credentials disappeared mid-run');
      return;
    }
    // d.caption verbatim. Approving text and posting different text would make
    // the review meaningless, so nothing regenerates or re-validates it here.
    const posted = await createPost(creds, {
      text: d.caption,
      mediaId: media.mediaId,
      madeWithAi: madeWithAiFlag()
    });
    if (!posted.ok) {
      await skip(
        posted.indeterminate ? SKIP_REASON.PostIndeterminate : SKIP_REASON.PostFailed,
        posted.reason
      );
      return;
    }

    // The published record. A NEW event rather than a mutation of the draft --
    // the log is append-only, and the draft plus this pair reads as "proposed,
    // then published", which is the history worth keeping.
    const sent: DispatchSentPayload = {
      ...d,
      slotKey,
      mode: 'live',
      postId: posted.postId,
      postUrl: posted.url
    };
    try {
      await appendEvent({
        type: EVENT_TYPE.DispatchSent,
        subjectType: SUBJECT_TYPE.Dispatch,
        subjectId: dateKey,
        payload: { ...sent, approvedFromDraft: draftEventId },
        dedupeKey: outcomeKey
      });
    } catch (err) {
      await skip(
        SKIP_REASON.PostIndeterminate,
        `posted ${posted.postId} but recording it failed: ${errText(err)}`
      );
    }
  } catch (err) {
    await skip(SKIP_REASON.InternalError, `unhandled failure: ${errText(err)}`);
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function prepareMedia(
  blobUrl: string
): Promise<{ ok: true; mediaId: string } | { ok: false; reason: string }> {
  const creds = getXCredentials();
  if (!creds) return { ok: false, reason: 'X credentials are not configured' };

  const image = await fetchSpecimenImage(blobUrl, IMAGE_FETCH_TIMEOUT_MS);
  if (!image.ok) return { ok: false, reason: image.reason };
  // Identified from the file signature, not from any header or column. Same
  // reasoning as the scheduled path.
  if (!LIVE_STILL_MIMES.has(image.mime.toLowerCase())) {
    return { ok: false, reason: `specimen is ${image.mime}, which is not a postable still image` };
  }
  return uploadMedia(creds, image.bytes, image.mime);
}
