import type { Job } from '@/lib/db/schema';
import { PUBLISH_JOB_TIMEOUT_MS, type JobContext } from '@/lib/jobs/worker';
import { appendEvent, getEvent } from '@/lib/db/queries/events';
import {
  currentPostState,
  definiteFailureGeneration,
  publishAttemptGeneration
} from '@/lib/db/queries/dispatch';
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
  canFinishPostPhase,
  canStartPostPhase,
  dispatchLiveEnabled,
  liveEligible,
  madeWithAiFlag
} from '@/lib/dispatch/config';
import { createPost, fetchSpecimenImage, getXCredentials, uploadMedia } from '@/lib/dispatch/x-client';
import { SKIP_REASON, type SkipReason } from '@/lib/dispatch/types';
import { utcDateKey } from '@/lib/dispatch/schedule';

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

  // This job's OWN timeout, not x.dispatch's. The wrapper does not cancel the
  // handler, so a deadline borrowed from a longer-running job type would let the
  // post start after this one has already been given up on.
  const postDeadlineAt = Math.min(Date.now() + PUBLISH_JOB_TIMEOUT_MS, ctx.invocationDeadlineAt);

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

  // The date this publication HAPPENS, not the date the draft was written. A
  // draft approved the next morning is a post made that morning, and the cron
  // route asks livePostAttemptedOnDate(today) before enqueueing -- filing under
  // the draft's date would hide the manual post from that check and let the
  // scheduler post again hours later, breaking the rule that a manual live post
  // stands down the day's automatic one. The draft's own date stays on the
  // payload for provenance.
  const dateKey = utcDateKey(new Date());

  // A slot of this publication's own. Reusing the draft's slot looked harmless
  // and was not: the draft's dispatch.sent already carries it, so
  // listUnresolvedAttempts would see an outcome for that slot and treat this
  // attempt as resolved before it started -- silently disarming the one warning
  // that says a post may exist with nothing recording it, on the exact path
  // where a human just authorised a post.
  const generation = await publishAttemptGeneration(draftEventId);
  const publishSlot = `${d.slotKey}:publish:${draftEventId}:${generation}`;

  // ---- the approval claim. This, not the button, is what makes one approval
  // publish once: a double click, a retried enqueue, or two admins on the same
  // page all collapse here. Keyed WITH the generation so a definite failure
  // releases it -- see dedupeKey.dispatchApproval.
  const approval = await appendEvent({
    type: EVENT_TYPE.DispatchApproved,
    subjectType: SUBJECT_TYPE.Dispatch,
    subjectId: dateKey,
    payload: {
      draftEventId,
      slotKey: publishSlot,
      imageId: d.imageId,
      slug: d.slug
    } satisfies DispatchApprovedPayload,
    dedupeKey: dedupeKey.dispatchApproval(draftEventId, generation)
  });
  if (!approval.inserted) return;

  const skip = async (reason: SkipReason, detail: string) => {
    await appendEvent({
      type: EVENT_TYPE.DispatchSkipped,
      subjectType: SUBJECT_TYPE.Dispatch,
      subjectId: dateKey,
      payload: {
        slotKey: publishSlot,
        // Carried so publishAttemptGeneration can count this attempt and free
        // the approval for a retry when nothing was published.
        draftEventId,
        mode: 'live',
        trigger: 'manual',
        reason,
        detail: detail.slice(0, 500),
        trendTopic: d.trendTopic ?? null
      } satisfies DispatchSkippedPayload,
      dedupeKey: dedupeKey.dispatchOutcome(publishSlot)
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
    const specimenGeneration = await definiteFailureGeneration(d.imageId);
    const attempt = await appendEvent({
      type: EVENT_TYPE.DispatchAttempted,
      subjectType: SUBJECT_TYPE.Dispatch,
      subjectId: dateKey,
      payload: {
        slotKey: publishSlot,
        trigger: 'manual',
        imageId: d.imageId,
        slug: d.slug
      } satisfies DispatchAttemptedPayload,
      dedupeKey: dedupeKey.dispatchAttempt(d.imageId, specimenGeneration)
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
      slotKey: publishSlot,
      mode: 'live',
      // An admin approving a draft is a MANUAL publication, whatever produced the
      // draft. Spreading `d` carried the draft's trigger through, so a scheduled
      // dry run published by hand rendered as an automatic post while its own
      // attempt and skip rows called it manual -- the log disagreeing with itself
      // about how something reached the account.
      trigger: 'manual',
      postId: posted.postId,
      postUrl: posted.url
    };
    try {
      await appendEvent({
        type: EVENT_TYPE.DispatchSent,
        subjectType: SUBJECT_TYPE.Dispatch,
        subjectId: dateKey,
        payload: { ...sent, approvedFromDraft: draftEventId, draftDateKey: draft.subjectId },
        dedupeKey: dedupeKey.dispatchOutcome(publishSlot)
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
