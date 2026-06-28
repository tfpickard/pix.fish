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

  // Claim one job at a time rather than a batch. A single long job (a 55s
  // fuse.render, umap.recompute, etc.) can consume the whole tick; with a batch
  // claim, the sibling rows moved to 'processing' up front but never reached
  // would sit stranded until the visibility timeout -- where reclaimStuckJobs now
  // treats a stuck row as a consumed attempt and would wrongly fail an unstarted
  // single-attempt job (e.g. fuse.render) that never actually ran. Claiming
  // as-we-go means a row enters 'processing' only immediately before it runs, so
  // reclaim only ever sees genuinely-abandoned (crashed mid-run) jobs. The long
  // jobs that dominate the queue already fill a whole tick each, so this costs no
  // real throughput.
  while (Date.now() - started < WALL_BUDGET_MS) {
    const [job] = await claimJobs(lockId, 1);
    if (!job) break;
    const result = await runJob(job);
    if (result === 'done') drained++;
    else if (result === 'failed') failed++;
    else retried++;
  }

  return NextResponse.json({ reclaimed, drained, retried, failed });
}

// Vercel Cron invokes the path with HTTP GET; ad-hoc triggers (curl,
// admin-driven manual drain) use POST. Both share the same drain logic.
export const GET = drain;
export const POST = drain;
