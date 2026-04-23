import type { Job } from '@/lib/db/schema';
import { markJobDone, markJobFailed, rescheduleJob } from '@/lib/db/queries/jobs';
import { handlers } from './handlers';

// Exponential backoff in ms, capped so the queue doesn't sleep for an
// absurdly long stretch after repeated failures.
function backoffMs(attempt: number): number {
  const base = 30_000;
  return Math.min(base * 2 ** attempt, 60 * 60_000);
}

export async function runJob(job: Job): Promise<'done' | 'retry' | 'failed'> {
  const handler = handlers[job.type];
  if (!handler) {
    await markJobFailed(job.id, `no handler for job type "${job.type}"`);
    return 'failed';
  }
  try {
    await handler(job);
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
