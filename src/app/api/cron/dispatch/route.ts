import { NextResponse } from 'next/server';
import { enqueueJob, hasInFlightScheduledDispatch } from '@/lib/db/queries/jobs';
import { dispatchMinuteForDate, isDispatchDue, utcDateKey } from '@/lib/dispatch/schedule';
import { eventExists } from '@/lib/db/queries/events';
import { livePostAttemptedOnDate } from '@/lib/db/queries/dispatch';
import { dedupeKey } from '@/lib/universe/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Drives the outbound X dispatch. Vercel Cron hits this on a coarse grid across
// the afternoon (see vercel.json); this route decides whether today's randomized
// fire time has arrived and, if so, enqueues exactly one x.dispatch job. Gated by
// CRON_SECRET, exactly like /api/cron/jobs and /api/cron/universe.
//
// Guards stop a second SCHEDULED dispatch, in ascending order of authority. The
// last one is the guarantee; the others just avoid pointless work and pointless
// queue rows:
//   1. this route checks whether the day is already claimed;
//   2. it declines when a live post already went out today by any route, so a
//      manual post cancels the day's automatic one;
//   3. it skips when a scheduled x.dispatch is already pending or processing;
//   4. the handler's day-claim event has a unique dedupe key, so even if the
//      checks above lose a race, only one scheduled run proceeds.
//
// None of this caps MANUAL dispatches. Those claim suffixed slots and are
// deliberately unlimited -- the rule being enforced here is "the scheduler posts
// at most once a day", not "the account posts at most once a day".
//
// maxAttempts 1 on the enqueue means a failed dispatch is never retried. The
// next day's tick is the only re-arm, which is the intended behaviour: a missed
// day is a correct outcome, a retried one risks a double post.
async function tick(req: Request) {
  const auth = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${process.env.CRON_SECRET ?? ''}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const now = new Date();
  const dateKey = utcDateKey(now);

  // Vercel Cron cannot jitter, so the fire time is derived from the date and the
  // grid ticks until it passes. Same date always yields the same target minute.
  if (!isDispatchDue(now)) {
    return NextResponse.json({
      enqueued: false,
      reason: 'not yet due',
      dateKey,
      targetUtcMinute: dispatchMinuteForDate(dateKey)
    });
  }

  if (await eventExists(dedupeKey.dispatchDay(dateKey))) {
    return NextResponse.json({ enqueued: false, reason: 'day already claimed', dateKey });
  }
  // A manual live post cancels the day's automatic one. Manual runs claim
  // suffixed slots so they can be fired as often as the operator likes -- that is
  // deliberate, and it means the day-claim above cannot see them. Without this
  // check, posting by hand at noon would still be followed by a scheduled post in
  // the afternoon, which is exactly the surprise the once-per-day rule exists to
  // prevent. The cap is on the SCHEDULER, not on the account's owner.
  if (await livePostAttemptedOnDate(dateKey)) {
    return NextResponse.json({ enqueued: false, reason: 'already posted live today', dateKey });
  }
  // Scoped to scheduled jobs. An admin review run is a separate slot and must not
  // stand in for the day's dispatch -- if one happened to be in flight during the
  // final tick of the day, a type-wide check would drop that day entirely.
  if (await hasInFlightScheduledDispatch()) {
    return NextResponse.json({ enqueued: false, reason: 'dispatch already in flight', dateKey });
  }

  const job = await enqueueJob({
    type: 'x.dispatch',
    payload: { dateKey, trigger: 'cron' },
    maxAttempts: 1
  });
  return NextResponse.json({ enqueued: 'x.dispatch', jobId: job.id, dateKey });
}

export const GET = tick; // Vercel Cron
export const POST = tick; // ad-hoc / manual
