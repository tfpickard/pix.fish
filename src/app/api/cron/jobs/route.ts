import { NextResponse } from 'next/server';
import { claimJobs, reclaimStuckJobs } from '@/lib/db/queries/jobs';
import { runJob } from '@/lib/jobs/worker';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

// 5-minute visibility timeout. Anything older than this while still in
// 'processing' is assumed abandoned (function died mid-handler, etc.).
const VISIBILITY_TIMEOUT_MS = 5 * 60_000;
// Stop claiming new work after this to respect the 60s function budget.
const WALL_BUDGET_MS = 55_000;
const BATCH = 10;

export async function POST(req: Request) {
  const auth = req.headers.get('authorization') ?? '';
  const expected = `Bearer ${process.env.CRON_SECRET ?? ''}`;
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const started = Date.now();
  const lockId = crypto.randomUUID();

  const reclaimed = await reclaimStuckJobs(new Date(started - VISIBILITY_TIMEOUT_MS));

  let drained = 0;
  let failed = 0;
  let retried = 0;

  while (Date.now() - started < WALL_BUDGET_MS) {
    const batch = await claimJobs(lockId, BATCH);
    if (batch.length === 0) break;
    for (const job of batch) {
      const result = await runJob(job);
      if (result === 'done') drained++;
      else if (result === 'failed') failed++;
      else retried++;
      if (Date.now() - started >= WALL_BUDGET_MS) break;
    }
  }

  return NextResponse.json({ reclaimed, drained, retried, failed });
}
