import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth, isSiteAdmin } from '@/lib/auth';
import { listDetectableImageIds } from '@/lib/db/queries/images';
import { enqueueJob, inFlightImageIds } from '@/lib/db/queries/jobs';

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
  // Skip images that already have an in-flight detect job so repeated clicks /
  // overlapping detect-all runs don't pile up redundant vision+embed work on the
  // same image (the in-handler crops/detectedAt guard catches the rest).
  const inFlight = await inFlightImageIds('characters.detect');
  let enqueued = 0;
  let skipped = 0;
  for (const imageId of ids) {
    if (inFlight.has(imageId)) {
      skipped++;
      continue;
    }
    await enqueueJob({ type: 'characters.detect', payload: { imageId, force }, maxAttempts: 2 });
    inFlight.add(imageId); // guard against dupes within this same request's id list
    enqueued++;
  }
  return NextResponse.json({ enqueued, skipped });
}
