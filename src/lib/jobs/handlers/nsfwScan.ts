import { eq } from 'drizzle-orm';
import type { Job } from '@/lib/db/schema';
import { db } from '@/lib/db/client';
import { images } from '@/lib/db/schema';
import { getNsfwClassifier } from '@/lib/ai/nsfwClassifier';
import { resolvePrompt } from '@/lib/prompts';

type Payload = { imageId: number };

// Providers prefer URL source; pass an empty buffer + the blob URL so we don't
// round-trip the image bytes through this function (mirrors reprocessImage).
const EMPTY_BUFFER = Buffer.alloc(0);

// feat/hud: classify a single image for nudity using the Haiku-pinned
// classifier and the seeded 'nsfw' prompt. Updates ONLY images.isNsfw and
// stamps nsfwSource='auto'. It NEVER touches tags, captions, descriptions, or
// embeddings, and it NEVER overrides a manual verdict (nsfwSource='manual').
export async function nsfwScanHandler(job: Job): Promise<void> {
  const { imageId } = job.payload as Payload;
  const [img] = await db.select().from(images).where(eq(images.id, imageId)).limit(1);
  if (!img) return;

  // Manual override always wins; do not even spend a model call on it.
  if (img.nsfwSource === 'manual') return;

  const classifier = await getNsfwClassifier(img.ownerId);
  // No usable key -> skip, exactly like the null-provider case elsewhere. The
  // row keeps whatever verdict it already had and stays eligible for a rescan.
  if (!classifier) return;

  const prompt = await resolvePrompt('nsfw');
  const mime = img.mime ?? 'image/jpeg';
  const isNsfw = await classifier.classify(EMPTY_BUFFER, mime, prompt, img.blobUrl);

  await db
    .update(images)
    .set({ isNsfw, nsfwSource: 'auto' })
    .where(eq(images.id, img.id));
}
