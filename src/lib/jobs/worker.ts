import type { Job } from '@/lib/db/schema';
import { markJobDone, markJobFailed, rescheduleJob } from '@/lib/db/queries/jobs';
import { handlers } from './handlers';

// Exponential backoff in ms, capped so the queue doesn't sleep for an
// absurdly long stretch after repeated failures.
function backoffMs(attempt: number): number {
  const base = 30_000;
  return Math.min(base * 2 ** attempt, 60 * 60_000);
}

// Per-type budget. A stuck handler would otherwise run past the 60s
// Vercel function wall, burn the cron invocation, and get re-claimed by
// the 5-min visibility timeout -- repeating forever. Capping each job
// locally turns a hang into a normal retry-or-fail transition.
// Kept under the cron drain's WALL_BUDGET_MS (55s) so a timeout doesn't
// itself overrun the tick budget.
const JOB_TIMEOUT_MS: Record<string, number> = {
  'webhook.deliver': 25_000, // fetch itself aborts at 10s; leave slack for slow DNS
  'reprocess.image': 50_000, // 3 parallel vision calls; Anthropic can run long
  'umap.recompute': 55_000, // single heavy job; fills the tick
  'backup.export': 55_000, // large zip upload; fills the tick
  noop: 5_000
};
const JOB_TIMEOUT_DEFAULT_MS = 45_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} exceeded per-job timeout of ${ms}ms`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export async function runJob(job: Job): Promise<'done' | 'retry' | 'failed'> {
  const handler = handlers[job.type];
  if (!handler) {
    await markJobFailed(job.id, `no handler for job type "${job.type}"`);
    return 'failed';
  }
  try {
    const timeoutMs = JOB_TIMEOUT_MS[job.type] ?? JOB_TIMEOUT_DEFAULT_MS;
    await withTimeout(handler(job), timeoutMs, `job ${job.id} (${job.type})`);
    await markJobDone(job.id);
    return 'done';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Use job.attempts (pre-increment) to compute the backoff window, then
    // reschedule. If the returned attempt count hits the cap, promote to
    // failed so the owner sees it in the admin jobs page.
    const nextAttempt = job.attempts + 1;
    const runAt = new Date(Date.now() + backoffMs(nextAttempt));
    const attemptsNow = await rescheduleJob(job.id, runAt, msg);
    if (attemptsNow >= job.maxAttempts) {
      await markJobFailed(job.id, msg);
      return 'failed';
    }
    return 'retry';
  }
}
