import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import { enqueueJob, hasInFlightJobOfType } from '@/lib/db/queries/jobs';
import { listRecentDispatchEvents } from '@/lib/db/queries/dispatch';
import { dispatchMinuteForDate, driftForDate, utcDateKey } from '@/lib/dispatch/schedule';
import { captionCharBudget, dispatchLiveEnabled } from '@/lib/dispatch/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Review surface for the outbound X dispatch. GET returns the dispatch slice of
// the event log (every would-be post and every skip, with its reason); POST
// enqueues an immediate review run.

export async function GET() {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const now = new Date();
  const dateKey = utcDateKey(now);
  const events = await listRecentDispatchEvents(60);
  return NextResponse.json({
    // Phase 1 has no X client, so nothing can post regardless of this flag. It is
    // surfaced so the review page can show how the deployment is configured.
    liveEnvEnabled: dispatchLiveEnabled(),
    livePostingImplemented: false,
    charBudget: captionCharBudget(),
    today: {
      dateKey,
      targetUtcMinute: dispatchMinuteForDate(dateKey),
      driftVariant: driftForDate(dateKey)
    },
    events: events.map((e) => ({
      id: e.id,
      type: e.type,
      dateKey: e.subjectId,
      payload: e.payload,
      createdAt: e.createdAt
    }))
  });
}

// A review run. It claims a suffixed slot rather than the real day's slot, so
// generating samples for review never consumes the day's single dispatch -- and
// never blocks the scheduled one. Always forced to dry run.
export async function POST() {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (await hasInFlightJobOfType('x.dispatch')) {
    return NextResponse.json({ enqueued: false, reason: 'dispatch already in flight' });
  }
  const now = new Date();
  const job = await enqueueJob({
    type: 'x.dispatch',
    payload: {
      dateKey: utcDateKey(now),
      trigger: 'manual',
      claimSuffix: `manual:${now.getTime()}`,
      dryRun: true
    },
    maxAttempts: 1
  });
  return NextResponse.json({ enqueued: 'x.dispatch', jobId: job.id });
}
