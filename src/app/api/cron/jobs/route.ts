import { NextResponse } from 'next/server';
import { claimJobs, reclaimStuckJobs, releaseJob } from '@/lib/db/queries/jobs';
import { runJob, jobBudgetMs } from '@/lib/jobs/worker';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

// 5-minute visibility timeout. Anything older than this while still in
// 'processing' is assumed abandoned (function died mid-handler, etc.).
const VISIBILITY_TIMEOUT_MS = 5 * 60_000;
// Stop claiming new work after this to respect the 60s function budget.
const WALL_BUDGET_MS = 55_000;
// A claimed job must be able to run its full per-type budget and still finish
// before the 60s function wall (with ~2s slack for the post-run bookkeeping
// write). If it can't fit in what's left of this invocation, defer it rather
// than start it -- otherwise a long single-attempt job (fuse.render) would be
// killed mid-run by the wall and reclaimed as failed, losing a paid result.
const JOB_FIT_DEADLINE_MS = 58_000;

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
  let deferred = 0;
  while (Date.now() - started < WALL_BUDGET_MS) {
    const [job] = await claimJobs(lockId, 1);
    if (!job) break;
    // If this job's worst-case runtime can't finish before the function wall,
    // don't start it. Release it (no attempt consumed) and stop: it's the oldest
    // eligible row, so the next tick -- starting fresh at t~=0 -- claims it first
    // with the full budget. Starting it here would risk a wall-kill mid-run and,
    // for a maxAttempts:1 paid render, a reclaim-to-failed that loses the result.
    if (Date.now() - started + jobBudgetMs(job.type) > JOB_FIT_DEADLINE_MS) {
      await releaseJob(job.id);
      deferred++;
      break;
    }
    const result = await runJob(job);
    if (result === 'done') drained++;
    else if (result === 'failed') failed++;
    else retried++;
  }

  return NextResponse.json({ reclaimed, drained, retried, failed, deferred });
}

// Vercel Cron invokes the path with HTTP GET; ad-hoc triggers (curl,
// admin-driven manual drain) use POST. Both share the same drain logic.
export const GET = drain;
export const POST = drain;
