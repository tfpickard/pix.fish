import { NextResponse } from 'next/server';
import { nextClusterRunStamp } from '@/lib/db/queries/events';
import { enqueueJob, hasInFlightJobOfType } from '@/lib/db/queries/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Safety net for the recurring-subjects roster. Vercel Cron hits this on a
// schedule (GET); it enqueues a single characters.cluster -- deduped against any
// already-pending one -- so the roster folds in newly-detected figures even if a
// per-detection debounce (see charactersDetect) ever failed to fire. Keeping
// enqueue and execution separate means this returns instantly and the heavy
// cluster -> verify -> census chain runs through the normal /api/cron/jobs drain
// budget. Empty payload -> the cluster resolves its knobs from the saved tuning.
// Gated by CRON_SECRET, exactly like /api/cron/jobs and /api/cron/universe.
async function tick(req: Request) {
  const auth = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${process.env.CRON_SECRET ?? ''}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Skip when a cluster is already pending OR processing -- the debounced enqueue,
  // a prior tick, or a run claimed and executing right now already covers this,
  // and a second run would just duplicate the corpus-wide verify/census fan-out.
  // (This is the cron safety net, where an in-flight run genuinely covers the
  // refresh; the per-detection handoff uses pending-only for the opposite reason.)
  if (await hasInFlightJobOfType('characters.cluster')) {
    return NextResponse.json({ enqueued: false, reason: 'cluster already in flight' });
  }
  // Stamp the run at enqueue (like /api/admin/characters/cluster) so a reclaimed
  // cluster reuses the same runStamp and collapses through the census dedupe key
  // rather than fanning out a duplicate. maxAttempts:1 matches that route; a
  // failed run is re-armed by the next tick. Knobs resolve from the saved tuning.
  const job = await enqueueJob({
    type: 'characters.cluster',
    payload: { runStamp: await nextClusterRunStamp() },
    maxAttempts: 1
  });
  return NextResponse.json({ enqueued: 'characters.cluster', jobId: job.id });
}

export const GET = tick; // Vercel Cron
export const POST = tick; // ad-hoc / manual
