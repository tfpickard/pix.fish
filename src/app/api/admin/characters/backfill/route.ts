import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import { resetAbandonedImageVecAttempts } from '@/lib/db/queries/character-crops';
import { enqueueJob } from '@/lib/db/queries/jobs';
import { clusterReadiness } from '@/lib/universe/visual-coverage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Visual-vector coverage: what still blocks a visual/blend cluster, and why.
// The clustering pipeline refuses to run on partial coverage, so this is the
// panel that explains a roster that has stopped updating -- previously the only
// signal was a failed characters.cluster job whose message named a count and no
// cause.
export async function GET() {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return NextResponse.json(await clusterReadiness());
}

// Enqueue the visual-vector backfill (Voyage multimodal) for crops that lack
// one. The job drains in batches and re-enqueues itself, so one click is enough.
// The handler is idempotent (only touches crops still missing a vec) and
// self-terminating, so a duplicate enqueue is harmless.
//
// `reset: true` first releases the crops the backfill gave up on. The per-crop
// attempt cap is a spend guard against permanently-dead crops, so releasing it
// is only right once the actual cause is fixed (a restored key, a corrected
// model id) -- hence an explicit opt-in rather than an automatic retry.
export async function POST(req: Request) {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const body = (await req.json().catch(() => ({}))) as { reset?: unknown };
  const released = body?.reset === true ? await resetAbandonedImageVecAttempts() : 0;
  const job = await enqueueJob({ type: 'characters.backfill-visuals', payload: {}, maxAttempts: 3 });
  return NextResponse.json({ jobId: job.id, released });
}
