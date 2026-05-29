import { and, eq, not } from 'drizzle-orm';
import type { Job } from '@/lib/db/schema';
import { db } from '@/lib/db/client';
import { images } from '@/lib/db/schema';
import { getNsfwClassifier } from '@/lib/ai/nsfwClassifier';
import { resolvePrompt } from '@/lib/prompts';

type Payload = { imageId: number };

// Providers prefer URL source; pass an empty buffer + the blob URL so we don't
// round-trip the image bytes through this function (mirrors reprocessImage).
const EMPTY_BUFFER = Buffer.alloc(0);

// A TRUE human NSFW override is the only thing this scan must never touch. The
// schema cannot label *why* nsfwSource is 'manual' (a real uploader assertion
// vs. the key-less default that enrichment-persist.ts stamps when no AI ran),
// so we use the one signal that disambiguates them: the manual_nsfw checkbox
// only ever forces isNsfw=true, it never asserts "definitely safe." Therefore
// (nsfwSource='manual' AND isNsfw=true) is always a deliberate human verdict,
// while (nsfwSource='manual' AND isNsfw=false) is only ever the key-less
// default and is safe to classify. See enrichment-persist.ts lines ~76-78.
// (Distinguishing the two cleanly would need a dedicated column; deferred.)
function isHumanNsfwOverride(img: { nsfwSource: string | null; isNsfw: boolean }): boolean {
  return img.nsfwSource === 'manual' && img.isNsfw === true;
}

// feat/hud: classify a single image for nudity using the Haiku-pinned
// classifier and the seeded 'nsfw' prompt. Updates ONLY images.isNsfw and
// stamps nsfwSource='auto'. It NEVER touches tags, captions, descriptions, or
// embeddings, and it NEVER overrides a true human verdict.
export async function nsfwScanHandler(job: Job): Promise<void> {
  const { imageId } = job.payload as Payload;
  const [img] = await db.select().from(images).where(eq(images.id, imageId)).limit(1);
  if (!img) return;

  // A real human override always wins; do not even spend a model call on it.
  // A key-less 'manual' default (isNsfw=false) still gets classified below.
  if (isHumanNsfwOverride(img)) return;

  const classifier = await getNsfwClassifier(img.ownerId);
  // No usable key -> skip, exactly like the null-provider case elsewhere. The
  // row keeps whatever verdict it already had and stays eligible for a rescan.
  if (!classifier) return;

  const prompt = await resolvePrompt('nsfw');
  const mime = img.mime ?? 'image/jpeg';
  const isNsfw = await classifier.classify(EMPTY_BUFFER, mime, prompt, img.blobUrl);

  // Atomic guard: re-check the human-override predicate in the WHERE clause so
  // an uploader who flips manual_nsfw=true while our classifier call was in
  // flight is never clobbered by this write. The early return above is only an
  // optimization; this predicate is the actual guarantee.
  await db
    .update(images)
    .set({ isNsfw, nsfwSource: 'auto' })
    .where(
      and(
        eq(images.id, img.id),
        not(and(eq(images.nsfwSource, 'manual'), eq(images.isNsfw, true))!)
      )
    );
}
