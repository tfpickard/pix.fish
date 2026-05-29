import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth, isSiteAdmin } from '@/lib/auth';
import { allImageIds } from '@/lib/db/queries/reprocess';
import { enqueueJob } from '@/lib/db/queries/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// feat/hud: enqueue one nsfw.scan job per target image. Mirrors
// /api/admin/reprocess. Each job runs the Haiku-pinned nudity classifier and
// updates ONLY images.isNsfw (and only when nsfwSource != 'manual'); see
// src/lib/jobs/handlers/nsfwScan.ts. We accept either scope:'all' or an
// explicit imageIds list so a future gallery multi-select can drive it without
// an API change. Never scope-caps silently.
const bodySchema = z.union([
  z.object({ scope: z.literal('all') }),
  z.object({ imageIds: z.array(z.number().int().positive()).min(1) })
]);

export async function POST(req: Request) {
  // Explicit in-handler gate: middleware only guarantees "signed in".
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', issues: parsed.error.issues },
      { status: 400 }
    );
  }

  // Resolve targets: explicit ids win; otherwise the full corpus.
  const targets =
    'imageIds' in parsed.data ? [...new Set(parsed.data.imageIds)] : await allImageIds();

  let enqueued = 0;
  for (const imageId of targets) {
    await enqueueJob({ type: 'nsfw.scan', payload: { imageId } });
    enqueued++;
  }
  return NextResponse.json({ enqueued, imageCount: targets.length });
}
