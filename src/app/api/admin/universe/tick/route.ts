import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth, isSiteAdmin } from '@/lib/auth';
import { enqueueJob } from '@/lib/db/queries/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z
  .object({
    count: z.number().int().min(1).max(8).optional(),
    seed: z.number().int().optional()
  })
  .default({});

// Manual trigger for the evolution loop, so an admin can run a tick on demand
// (e.g. to watch the canon move) without waiting for the cron schedule.
export async function POST(req: Request) {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', issues: parsed.error.issues }, { status: 400 });
  }
  // Stamp a seed at enqueue (unless the admin pinned one) so a reclaimed/re-run
  // tick reuses it and collapses through existing amendment dedupe keys.
  const payload = { ...parsed.data, seed: parsed.data.seed ?? Date.now() % 2_147_483_647 };
  const job = await enqueueJob({ type: 'universe.tick', payload, maxAttempts: 1 });
  return NextResponse.json({ jobId: job.id });
}
