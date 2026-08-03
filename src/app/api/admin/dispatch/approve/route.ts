import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import { enqueueJob, hasInFlightPostingDispatch } from '@/lib/db/queries/jobs';
import { getEvent } from '@/lib/db/queries/events';
import {
  currentPostState,
  publiclyPostedImageIds,
  publishedDraftIds,
  rejectedDraftIds,
  unpostableImageIds
} from '@/lib/db/queries/dispatch';
import { liveEligible } from '@/lib/dispatch/config';
import { EVENT_TYPE } from '@/lib/universe/events';
import type { DispatchSentPayload } from '@/lib/universe/events';
import { dispatchLiveEnabled } from '@/lib/dispatch/config';
import { missingXCredentialNames } from '@/lib/dispatch/x-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Approve one reviewed draft for publication.
//
// The draft is the artifact a review run already produced and wrote to the log in
// full. Approving enqueues a job that posts THAT draft verbatim -- see
// xDispatchPublish for why it must not regenerate.
//
// This route validates and enqueues; it does not post. Posting from a request
// handler would put an irreversible external call on a path with no job-level
// deadline, no visibility timeout, and no record if the function dies mid-flight.
export async function POST(req: Request) {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { eventId?: unknown };
  const eventId = Number(body.eventId);
  if (!Number.isFinite(eventId)) {
    return NextResponse.json({ error: 'eventId required' }, { status: 400 });
  }

  // Refuse rather than degrade, for the same reason the live run does: the
  // operator is asking for something public to happen, and a request that
  // reports success while nothing can post is how you conclude the linkage
  // works when it does not.
  if (!dispatchLiveEnabled()) {
    return NextResponse.json(
      { approved: false, reason: 'X_DISPATCH_LIVE is not "true" in this environment' },
      { status: 409 }
    );
  }
  const missing = missingXCredentialNames();
  if (missing.length > 0) {
    return NextResponse.json(
      { approved: false, reason: `missing credentials: ${missing.join(', ')}` },
      { status: 409 }
    );
  }

  const draft = await getEvent(eventId);
  if (!draft || draft.type !== EVENT_TYPE.DispatchSent) {
    return NextResponse.json({ approved: false, reason: 'not a dispatch draft' }, { status: 404 });
  }
  const payload = draft.payload as unknown as DispatchSentPayload;
  if (payload.postId) {
    return NextResponse.json({ approved: false, reason: 'this draft was already posted' });
  }
  // The draft row cannot answer "was this published?". The log is append-only, so
  // publishing writes a NEW dispatch.sent and the draft keeps postId=null
  // forever -- which is why the approve button used to survive a successful post
  // and report a queued publication on every click while the job no-opped.
  if ((await publishedDraftIds()).includes(eventId)) {
    return NextResponse.json({ approved: false, reason: 'this draft has already been published' });
  }

  // The draft's SPECIMEN may have gone out under a different draft, or under the
  // scheduled run, since this one was written. The publish job would then collide
  // on the specimen lock and file post_failed -- which is retryable, so the
  // button would survive and every click would queue another job that can never
  // publish. Checking the draft id alone cannot see this: the draft is untouched,
  // it is the image underneath it that is spent.
  //
  // publiclyPostedImageIds, NOT listDispatchedImageIds: the latter counts dry-run
  // drafts, so a SCHEDULED draft (trigger 'cron', null postId) had its own event
  // mark its specimen spent, and this route rejected the draft it was asked
  // about. Two questions that only looked alike.
  if ((await publiclyPostedImageIds()).includes(payload.imageId)) {
    return NextResponse.json({
      approved: false,
      reason: `specimen ${payload.imageId} has already been posted; generate a new draft`
    });
  }

  // A draft X has already refused outright. The caption is immutable -- that is
  // what makes approval mean anything -- so the publish job would send the same
  // bytes to the same endpoint and read the same rejection. Nothing about
  // re-approving can change the answer, so the draft is retired here rather than
  // left to burn one job per click.
  if ((await rejectedDraftIds()).includes(eventId)) {
    return NextResponse.json({
      approved: false,
      reason: 'X rejected this draft outright; generate a new one'
    });
  }

  // Is the SPECIMEN still publishable right now? A draft outlives the state it
  // was drafted from -- an admin can archive it, an nsfw.scan can reclassify it,
  // a reprocess can change its MIME -- and the gap between drafting and reading
  // is the whole point of review, so this is routine rather than exotic.
  //
  // The publish job re-checks this too and files post_failed, which is
  // RETRYABLE, so without the same check here the button survived a verdict that
  // is deterministic: every click queued a job that could only reach it again.
  const state = await currentPostState(payload.imageId);
  if (!state) {
    return NextResponse.json({
      approved: false,
      reason: `specimen ${payload.imageId} no longer exists; generate a new draft`
    });
  }
  if (state.gated || !liveEligible(state)) {
    return NextResponse.json({
      approved: false,
      reason: `specimen ${payload.imageId} is no longer publishable (gated=${state.gated}, nsfw=${state.isNsfw}, source=${state.nsfwSource}, mime=${state.mime}); generate a new draft`
    });
  }

  // Quarantined specimens fail deterministically. The publish job would write
  // dispatch.unpostable and a definite post_failed -- neither of which lands in
  // the published or posted sets, so the button survived and every click
  // repeated the identical failure on the identical bytes.
  if ((await unpostableImageIds()).includes(payload.imageId)) {
    return NextResponse.json({
      approved: false,
      reason: `specimen ${payload.imageId} cannot be posted (bad or oversized media); generate a new draft`
    });
  }

  // The SHARED guard, covering scheduled dispatches as well as other
  // publications. Checking only for another publish let an approval be queued
  // alongside a pending cron run, each posting a different specimen on the same
  // day -- neither handler looks for the other's job type, so nothing downstream
  // would have caught it.
  //
  // Advisory, as ever: the publish job re-checks the specimen and takes the
  // specimen lock. This only avoids queueing work certain to skip.
  if (await hasInFlightPostingDispatch()) {
    return NextResponse.json({ approved: false, reason: 'a dispatch is already in flight' });
  }

  const job = await enqueueJob({
    type: 'x.dispatch.publish',
    payload: { draftEventId: eventId },
    // Never retried, for the same reason as the dispatch itself: a retry that
    // succeeds after a timeout has already posted.
    maxAttempts: 1
  });
  return NextResponse.json({ approved: true, jobId: job.id });
}
