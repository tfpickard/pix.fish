import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import { enqueueJob, hasInFlightJobOfType } from '@/lib/db/queries/jobs';
import { getEvent } from '@/lib/db/queries/events';
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

  // Advisory. The publish job re-checks the specimen and takes the specimen lock;
  // this only avoids queueing work that is certain to skip.
  if (await hasInFlightJobOfType('x.dispatch.publish')) {
    return NextResponse.json({ approved: false, reason: 'a publish is already in flight' });
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
