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
// cron tick so a handler that died mid-flight can retry on the next pass.
export async function reclaimStuckJobs(olderThan: Date): Promise<number> {
  const res = await db
    .update(jobs)
    .set({ status: 'pending', lockedBy: null, lockedAt: null })
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
