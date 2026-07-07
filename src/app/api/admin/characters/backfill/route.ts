import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import { enqueueJob } from '@/lib/db/queries/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Enqueue the visual-vector backfill (Voyage multimodal) for crops that lack
// one. The job drains in batches and re-enqueues itself, so one click is enough.
// The handler is idempotent (only touches crops still missing a vec) and
// self-terminating, so a duplicate enqueue is harmless.
export async function POST() {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const job = await enqueueJob({ type: 'characters.backfill-visuals', payload: {}, maxAttempts: 3 });
  return NextResponse.json({ jobId: job.id });
}
