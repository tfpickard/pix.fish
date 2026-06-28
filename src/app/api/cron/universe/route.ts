import { NextResponse } from 'next/server';
import { enqueueJob } from '@/lib/db/queries/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Drives the universe evolution loop. Vercel Cron hits this on a schedule (GET);
// it just enqueues a single universe.tick job, which the regular /api/cron/jobs
// drain then runs. Keeping enqueue and execution separate means this endpoint
// returns instantly and the heavy work goes through the normal job budget.
// Gated by CRON_SECRET, exactly like /api/cron/jobs.
async function tick(req: Request) {
  const auth = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${process.env.CRON_SECRET ?? ''}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Stamp the seed at enqueue time so a reclaimed/re-run tick reuses it and the
  // same logical tick collapses through the existing amendment dedupe keys
  // instead of emitting a fresh set of nonces.
  const seed = Date.now() % 2_147_483_647;
  const job = await enqueueJob({ type: 'universe.tick', payload: { seed }, maxAttempts: 1 });
  return NextResponse.json({ enqueued: 'universe.tick', jobId: job.id });
}

export const GET = tick; // Vercel Cron
export const POST = tick; // ad-hoc / manual
