import { NextResponse } from 'next/server';
import { claimJobs, reclaimStuckJobs, releaseUnstartedJobs } from '@/lib/db/queries/jobs';
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

async function drain(req: Request) {
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

  // Rows we claimed but never got to, handed straight back rather than left
  // marked `processing` for the visibility timeout to rescue. A batch is
  // claimed all at once and run sequentially, so a single job allowed most of
  // the wall budget (umap.recompute gets 55s) can strand the nine behind it for
  // five minutes -- and since an atlas refresh is now scheduled by ordinary
  // uploads rather than an admin clicking recompute, that head-of-line stall
  // would land on routine enrichment and webhook delivery.
  let released = 0;

  outer: while (Date.now() - started < WALL_BUDGET_MS) {
    const batch = await claimJobs(lockId, BATCH);
    if (batch.length === 0) break;
    for (let i = 0; i < batch.length; i++) {
      const result = await runJob(batch[i]!);
      if (result === 'done') drained++;
      else if (result === 'failed') failed++;
      else retried++;
      if (Date.now() - started >= WALL_BUDGET_MS) {
        released += await releaseUnstartedJobs(
          lockId,
          batch.slice(i + 1).map((j) => j.id)
        );
        break outer;
      }
    }
  }

  return NextResponse.json({ reclaimed, drained, retried, failed, released });
}

// Vercel Cron invokes the path with HTTP GET; ad-hoc triggers (curl,
// admin-driven manual drain) use POST. Both share the same drain logic.
export const GET = drain;
export const POST = drain;
