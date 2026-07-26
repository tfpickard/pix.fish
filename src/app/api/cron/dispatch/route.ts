import { NextResponse } from 'next/server';
import { enqueueJob, hasInFlightJobOfType } from '@/lib/db/queries/jobs';
import { dispatchMinuteForDate, isDispatchDue, utcDateKey } from '@/lib/dispatch/schedule';
import { eventExists } from '@/lib/db/queries/events';
import { dedupeKey } from '@/lib/universe/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Drives the outbound X dispatch. Vercel Cron hits this on a coarse grid across
// the afternoon (see vercel.json); this route decides whether today's randomized
// fire time has arrived and, if so, enqueues exactly one x.dispatch job. Gated by
// CRON_SECRET, exactly like /api/cron/jobs and /api/cron/universe.
//
// Three independent guards stop a second dispatch, in ascending order of
// authority. The last one is the guarantee; the first two just avoid pointless
// work and pointless queue rows:
//   1. this route checks whether the day is already claimed;
//   2. it skips when an x.dispatch is already pending or processing;
//   3. the handler's day-claim event has a unique dedupe key, so even if both
//      checks above lose a race, only one run proceeds.
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
  if (await hasInFlightJobOfType('x.dispatch')) {
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
