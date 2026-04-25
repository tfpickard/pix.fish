import { eq } from 'drizzle-orm';
import type { Job } from '@/lib/db/schema';
import { db } from '@/lib/db/client';
import { captions, images } from '@/lib/db/schema';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { loadUserProviderKeys } from '@/lib/ai/keys';
import { enrichImage } from '@/lib/enrichment';
import { persistEnrichment } from '@/lib/enrichment-persist';

// Providers prefer the blob URL; pass an empty buffer to avoid round-tripping
// the original file through Postgres just to hand it back out to Anthropic.
const EMPTY_BUFFER = Buffer.alloc(0);

type Payload = {
  imageId: number;
  // Phase E: manual upload-form values that ride along the enrich job so
  // the persist step can apply them after the AI pass (or in lieu of it,
  // for key-less uploads).
  manualDescription?: string;
  manualTags?: string[];
  manualNsfw?: boolean;
};

export async function enrichImageHandler(job: Job): Promise<void> {
  const payload = job.payload as Payload;
  const [img] = await db.select().from(images).where(eq(images.id, payload.imageId)).limit(1);
  if (!img) return;

  // Idempotency guard: if a previous attempt committed the captions tx and
  // then crashed before markJobDone, a retry would double-enrich. Bail out
  // silently so the webhook also doesn't re-fire.
  const [existingCap] = await db
    .select({ id: captions.id })
    .from(captions)
    .where(eq(captions.imageId, img.id))
    .limit(1);
  if (existingCap) return;

  const cfg = await loadAiConfig();
  // BYO: every outbound provider call uses the image owner's key. If a
  // user has no key for the configured provider, that field is skipped
  // and the upload's manual fields take over (handled in persistEnrichment).
  const userKeys = await loadUserProviderKeys(img.ownerId);
  const manualCaption = img.manualCaption ?? undefined;
  const enrichment = await enrichImage(
    EMPTY_BUFFER,
    img.mime ?? 'image/jpeg',
    cfg,
    userKeys,
    manualCaption,
    img.blobUrl
  );

  await persistEnrichment({
    imageId: img.id,
    ownerId: img.ownerId,
    placeholderSlug: img.slug,
    manualCaption,
    manualDescription: payload.manualDescription,
    manualTags: payload.manualTags,
    manualNsfw: payload.manualNsfw,
    enrichment,
    cfg,
    userKeys
  });
}
