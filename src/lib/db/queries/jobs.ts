import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../client';
import { jobs } from '../schema';
import type { Job, NewJob } from '../schema';

export async function enqueueJob(row: {
  type: string;
  payload: unknown;
  runAt?: Date;
  maxAttempts?: number;
}): Promise<Job> {
  const values: NewJob = {
    type: row.type,
    payload: row.payload as Job['payload'],
    runAt: row.runAt ?? new Date(),
    ...(row.maxAttempts !== undefined ? { maxAttempts: row.maxAttempts } : {})
  };
  const [inserted] = await db.insert(jobs).values(values).returning();
  if (!inserted) throw new Error('enqueueJob returned no row');
  return inserted;
}

// Reclaim rows whose visibility-timeout lease expired. Runs at the top of the
// cron tick. A row still 'processing' past the timeout means the worker that
// claimed it died mid-flight -- on Vercel the function is killed at the 60s wall,
// so it is definitely not still running. Count that as a consumed attempt: bump
// attempts and, if that reaches maxAttempts, mark the job 'failed' instead of
// re-queuing it. This stops a single-attempt paid job (fuse.render,
// maxAttempts: 1) from being re-claimed and BILLED A SECOND TIME after a crash
// or deploy, while still letting multi-attempt idempotent jobs retry as before.
export async function reclaimStuckJobs(olderThan: Date): Promise<number> {
  const res = await db
    .update(jobs)
    .set({
      attempts: sql`${jobs.attempts} + 1`,
      status: sql`CASE WHEN ${jobs.attempts} + 1 >= ${jobs.maxAttempts} THEN 'failed' ELSE 'pending' END`,
      finishedAt: sql`CASE WHEN ${jobs.attempts} + 1 >= ${jobs.maxAttempts} THEN NOW() ELSE ${jobs.finishedAt} END`,
      lastError: sql`CASE WHEN ${jobs.attempts} + 1 >= ${jobs.maxAttempts} THEN 'reclaimed after visibility timeout (worker died mid-job); not retried' ELSE ${jobs.lastError} END`,
      lockedBy: null,
      lockedAt: null
    })
    .where(and(eq(jobs.status, 'processing'), sql`${jobs.lockedAt} < ${olderThan.toISOString()}`))
    .returning({ id: jobs.id });
  return res.length;
}

type RawJobRow = {
  id: number;
  type: string;
  payload: unknown;
  status: string;
  attempts: number;
  max_attempts: number;
  run_at: string | Date;
  started_at: string | Date | null;
  finished_at: string | Date | null;
  locked_by: string | null;
  locked_at: string | Date | null;
  last_error: string | null;
  created_at: string | Date;
};

function normalizeJob(r: RawJobRow): Job {
  return {
    id: r.id,
    type: r.type,
    payload: r.payload as Job['payload'],
    status: r.status,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    runAt: new Date(r.run_at),
    startedAt: r.started_at ? new Date(r.started_at) : null,
    finishedAt: r.finished_at ? new Date(r.finished_at) : null,
    lockedBy: r.locked_by,
    lockedAt: r.locked_at ? new Date(r.locked_at) : null,
    lastError: r.last_error,
    createdAt: new Date(r.created_at)
  };
}

// Claim up to `limit` pending rows atomically. SKIP LOCKED lets overlapping
// cron invocations proceed without blocking each other.
export async function claimJobs(lockId: string, limit: number): Promise<Job[]> {
  const res = await db.execute<RawJobRow>(sql`
    WITH claimed AS (
      SELECT id FROM jobs
      WHERE status = 'pending' AND run_at <= NOW()
      ORDER BY run_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE jobs j
    SET status = 'processing',
        locked_by = ${lockId},
        locked_at = NOW(),
        started_at = NOW()
    FROM claimed
    WHERE j.id = claimed.id
    RETURNING j.*
  `);
  return res.rows.map(normalizeJob);
}

// Read one job by id. Used by the /fuse render poll to report status + result.
export async function getJob(id: number): Promise<Job | null> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  return row ?? null;
}

// Overwrite a job's payload. A handler uses this to stash its result (e.g. the
// rendered blob URL) on the job so a poll endpoint can hand it back; the worker
// then marks the job done.
export async function updateJobPayload(id: number, payload: unknown): Promise<void> {
  await db
    .update(jobs)
    .set({ payload: payload as Job['payload'] })
    .where(eq(jobs.id, id));
}

// Return a claimed job to the queue WITHOUT consuming an attempt or rescheduling
// it. Used by the cron drain to defer a job it claimed but cannot finish within
// the remaining function budget, so a long single-attempt job (fuse.render) is
// never started just to be killed by the wall and reclaimed as failed. Its runAt
// is left in the past, so it stays the oldest eligible row and is claimed first
// on the next tick (where it has the full budget).
export async function releaseJob(id: number): Promise<void> {
  await db
    .update(jobs)
    .set({ status: 'pending', lockedBy: null, lockedAt: null })
    .where(eq(jobs.id, id));
}

export async function markJobDone(id: number): Promise<void> {
  await db
    .update(jobs)
    .set({ status: 'done', finishedAt: new Date(), lockedBy: null, lockedAt: null })
    .where(eq(jobs.id, id));
}

export async function markJobFailed(id: number, err: string): Promise<void> {
  await db
    .update(jobs)
    .set({ status: 'failed', finishedAt: new Date(), lastError: err, lockedBy: null, lockedAt: null })
    .where(eq(jobs.id, id));
}

// Bumps attempts and stages the row for another run; returns the new attempt
// count so the worker can compare it against maxAttempts.
export async function rescheduleJob(id: number, runAt: Date, err: string): Promise<number> {
  const [row] = await db
    .update(jobs)
    .set({
      status: 'pending',
      runAt,
      lockedBy: null,
      lockedAt: null,
      attempts: sql`${jobs.attempts} + 1`,
      lastError: err
    })
    .where(eq(jobs.id, id))
    .returning({ attempts: jobs.attempts });
  return row?.attempts ?? 0;
}

export async function jobsOverview(limit = 50): Promise<{
  counts: { type: string; status: string; count: number }[];
  recent: Job[];
}> {
  const counts = await db.execute<{ type: string; status: string; count: number }>(sql`
    SELECT type, status, count(*)::int AS count FROM jobs GROUP BY type, status ORDER BY type, status
  `);
  const recent = await db.select().from(jobs).orderBy(desc(jobs.createdAt)).limit(limit);
  return {
    counts: counts.rows.map((r) => ({ type: r.type, status: r.status, count: Number(r.count) })),
    recent
  };
}
