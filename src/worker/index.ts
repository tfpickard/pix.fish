/**
 * Standalone job queue worker.
 *
 *   bun run worker
 *
 * This replaces `/api/cron/jobs` as the drain path. That route stays in place
 * as a manual escape hatch, but nothing calls it on a schedule any more.
 *
 * Why this exists. The queue's whole shape -- a 55s wall budget, a 5-minute
 * visibility timeout, batches of 10, an every-minute cron tick -- was built
 * around one fact: a Vercel function is killed at 60 seconds. None of it was
 * about queue design. Running a process that simply stays up removes the
 * constraint the design was working around.
 *
 * Two deliberate differences from the cron drain, both consequences of that:
 *
 * 1. It claims ONE job at a time, not ten. The batch existed to amortize
 *    claiming across a tick that was about to expire anyway. Here there is no
 *    tick, and a batch is actively worse: a shutdown mid-batch leaves the
 *    unstarted remainder parked in 'processing' until the visibility timeout
 *    reclaims them, so a deploy would strand nine jobs for five minutes. With a
 *    single claim, at most one job is ever in flight.
 *
 * 2. `invocationDeadlineAt` is now this job's own timeout rather than a budget
 *    shared with nine siblings. Handlers with irreversible side effects consult
 *    it to decide whether they have time to finish what they are about to
 *    start, so it has to be true. It is read through `jobTimeoutMs` rather than
 *    recomputed here: a second copy of those numbers would drift from the table
 *    that actually enforces them.
 *
 * What did NOT change: the per-type budgets themselves. They are still sized
 * for the old 55s tick and a persistent worker could afford far more, but
 * raising them is its own change with its own testing, not a free rider on this
 * one. See the PUBLISH_JOB_TIMEOUT_MS comment in src/lib/jobs/worker.ts for
 * what a mis-measured budget cost the last time.
 *
 * Concurrency is also unchanged: jobs run one after another. Running several at
 * once would help throughput, but sharp encodes and a UMAP recompute landing
 * together would blow a 4GB box, and `MemoryMax` on the systemd unit would kill
 * the worker rather than slow it down.
 */
import { randomUUID } from 'node:crypto';
import { claimJobs, reclaimStuckJobs } from '@/lib/db/queries/jobs';
import { runJob, jobTimeoutMs } from '@/lib/jobs/worker';
import { closeDb } from '@/lib/db/client';

// Matches the cron drain's contract: a row still 'processing' beyond this is
// assumed abandoned by a worker that died mid-handler.
const VISIBILITY_TIMEOUT_MS = 5 * 60_000;
// Reclaiming is a corpus-wide UPDATE, so it runs on its own slow cadence rather
// than on every claim.
const RECLAIM_INTERVAL_MS = 60_000;
// How long to wait before asking again when the queue is empty. Short enough
// that an upload's enrich job starts promptly, long enough to leave the
// database alone while idle.
const IDLE_SLEEP_MS = 2_000;
// Backoff after a database error, so a Neon blip does not become a hot loop.
const DB_ERROR_SLEEP_MS = 5_000;

let shuttingDown = false;
let wakeFromSleep: (() => void) | null = null;

// Sleep that a shutdown signal can cut short, so SIGTERM during an idle poll
// exits immediately instead of waiting out the interval.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeFromSleep = null;
      resolve();
    }, ms);
    wakeFromSleep = () => {
      clearTimeout(timer);
      wakeFromSleep = null;
      resolve();
    };
  });
}

function requestShutdown(signal: string): void {
  if (shuttingDown) {
    // A second signal means someone is not willing to wait for the in-flight
    // job. Honour that rather than appearing hung.
    console.warn(`worker: ${signal} again, exiting now`);
    process.exit(130);
  }
  console.log(`worker: ${signal} received, finishing in-flight job then exiting`);
  shuttingDown = true;
  wakeFromSleep?.();
}

process.on('SIGTERM', () => requestShutdown('SIGTERM'));
process.on('SIGINT', () => requestShutdown('SIGINT'));

async function main(): Promise<void> {
  if (!process.env.POSTGRES_URL) {
    console.error('worker: POSTGRES_URL not set. Aborting.');
    process.exit(1);
  }

  // Identifies this worker's claims in jobs.locked_by. Fresh per process, so a
  // restarted worker never mistakes its predecessor's rows for its own.
  const lockId = randomUUID();
  console.log(`worker: started (lock ${lockId})`);

  let lastReclaimAt = 0;

  while (!shuttingDown) {
    if (Date.now() - lastReclaimAt >= RECLAIM_INTERVAL_MS) {
      lastReclaimAt = Date.now();
      try {
        const reclaimed = await reclaimStuckJobs(new Date(Date.now() - VISIBILITY_TIMEOUT_MS));
        if (reclaimed > 0) console.log(`worker: reclaimed ${reclaimed} stuck job(s)`);
      } catch (err) {
        console.error('worker: reclaim failed', err);
      }
    }

    let batch;
    try {
      batch = await claimJobs(lockId, 1);
    } catch (err) {
      console.error('worker: claim failed', err);
      await sleep(DB_ERROR_SLEEP_MS);
      continue;
    }

    const job = batch[0];
    if (!job) {
      await sleep(IDLE_SLEEP_MS);
      continue;
    }

    const startedAt = Date.now();
    try {
      // runJob owns the outcome entirely: it marks done, reschedules with
      // backoff, or promotes to failed at maxAttempts. It does not throw for a
      // failing job, so anything caught here is the queue itself misbehaving.
      const result = await runJob(job, {
        invocationDeadlineAt: Date.now() + jobTimeoutMs(job.type)
      });
      console.log(`worker: job ${job.id} (${job.type}) ${result} in ${Date.now() - startedAt}ms`);
    } catch (err) {
      console.error(`worker: job ${job.id} (${job.type}) raised past runJob`, err);
    }
  }

  console.log('worker: draining connection pool');
  await closeDb();
  console.log('worker: stopped');
}

main().catch(async (err) => {
  console.error('worker: fatal', err);
  // Best effort: a pool that will not close should not stop the process from
  // exiting non-zero so systemd restarts it.
  await closeDb().catch(() => {});
  process.exit(1);
});
