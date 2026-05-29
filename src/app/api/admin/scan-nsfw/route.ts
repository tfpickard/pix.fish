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
//
// One object shape (not a union) so a caller that sends BOTH scope:'all' and
// imageIds doesn't silently match the scope branch and get imageIds stripped --
// which would scan the whole gallery instead of the requested rows. Explicit
// imageIds always win; scope:'all' is only honored when no imageIds are given.
const bodySchema = z
  .object({
    scope: z.literal('all').optional(),
    imageIds: z.array(z.number().int().positive()).min(1).optional()
  })
  .refine((d) => d.scope === 'all' || (d.imageIds && d.imageIds.length > 0), {
    message: "provide scope:'all' or a non-empty imageIds array"
  });

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
    parsed.data.imageIds && parsed.data.imageIds.length > 0
      ? [...new Set(parsed.data.imageIds)]
      : await allImageIds();

  let enqueued = 0;
  for (const imageId of targets) {
    await enqueueJob({ type: 'nsfw.scan', payload: { imageId } });
    enqueued++;
  }
  return NextResponse.json({ enqueued, imageCount: targets.length });
}
