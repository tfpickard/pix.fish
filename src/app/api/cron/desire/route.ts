import { NextResponse } from 'next/server';
import { enqueueIfNoneInFlight } from '@/lib/db/queries/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Nightly lifecycle tick for desire paths. Vercel Cron hits this (GET); it
// enqueues a single desire.promote -- deduped against any already-pending or
// processing one -- which assembles worn path_traffic edges into corridors,
// files the ones above the strength floor, and retires the ones that decayed.
//
// Without this the promote job only ever ran from /admin/desire/promote, so a
// production gallery accumulated traffic forever and /paths stayed empty: the
// corridors were never promoted and never retired. Keeping enqueue separate
// from execution means this returns instantly and the heavy assemble ->
// caption -> file chain runs inside the normal /api/cron/jobs drain budget.
//
// Empty payload -> the handler uses its default floors. Gated by CRON_SECRET,
// exactly like /api/cron/jobs, /api/cron/universe and /api/cron/characters.
async function tick(req: Request) {
  const auth = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${process.env.CRON_SECRET ?? ''}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Skip when a promote is already pending OR processing. Promotion is
  // corpus-wide and idempotent per run, so a second concurrent pass would just
  // duplicate the assemble/caption work -- and two runs racing on the same
  // edge_sig upsert is exactly the collision the handler has to retry around.
  //
  // The check and the insert are one atomic operation rather than two calls:
  // the scheduled GET and an ad-hoc POST can overlap, and a separate
  // check-then-enqueue lets both observe "none in flight" and both file a job,
  // which for a corpus-wide job means paying the caption budget twice.
  //
  // maxAttempts:2 matches the admin trigger -- a transient DB/provider blip
  // gets one retry, and a genuinely failed run is re-armed by the next tick
  // rather than being retried forever.
  const job = await enqueueIfNoneInFlight({
    type: 'desire.promote',
    payload: {},
    maxAttempts: 2
  });
  if (!job) {
    return NextResponse.json({ enqueued: false, reason: 'promote already in flight' });
  }
  return NextResponse.json({ enqueued: 'desire.promote', jobId: job.id });
}

export const GET = tick; // Vercel Cron
export const POST = tick; // ad-hoc / manual
