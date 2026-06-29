import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth, isSiteAdmin } from '@/lib/auth';
import { listDetectableImageIds } from '@/lib/db/queries/images';
import { enqueueJob } from '@/lib/db/queries/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z
  .object({
    // Re-detect images that already have crops (clears + re-crops).
    force: z.boolean().optional(),
    // Optionally limit to specific images; defaults to all eligible.
    imageIds: z.array(z.number().int()).optional()
  })
  .default({});

// Enqueue a characters.detect job per eligible (non-NSFW, non-archived) image.
// The cron drain runs them; each crops + embeds that image's figures.
export async function POST(req: Request) {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', issues: parsed.error.issues }, { status: 400 });
  }
  const { force = false, imageIds } = parsed.data;
  const ids = imageIds && imageIds.length > 0 ? imageIds : await listDetectableImageIds();
  for (const imageId of ids) {
    await enqueueJob({ type: 'characters.detect', payload: { imageId, force }, maxAttempts: 2 });
  }
  return NextResponse.json({ enqueued: ids.length });
}
