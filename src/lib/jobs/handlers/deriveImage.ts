import { eq } from 'drizzle-orm';
import type { Job } from '@/lib/db/schema';
import { db } from '@/lib/db/client';
import { images } from '@/lib/db/schema';
import { generateImageDerivatives } from '@/lib/images/generate';

// Post-upload derivative generation. Enqueued by the enrich.image handler once
// an upload is enriched, so new uploads get the same small WebP derivatives the
// offline backfill produces -- without putting sharp on the upload's critical
// path or risking the enrich job's timeout. Idempotent: skips rows that already
// have derivatives (null means "not yet"; an empty array means "processed,
// none needed" e.g. animated originals), so a retry after a partial failure is
// safe.
type Payload = { imageId: number };

export async function deriveImageHandler(job: Job): Promise<void> {
  const { imageId } = job.payload as Payload;
  const [img] = await db
    .select({ id: images.id, blobUrl: images.blobUrl, blobKey: images.blobKey, derivatives: images.derivatives })
    .from(images)
    .where(eq(images.id, imageId))
    .limit(1);
  if (!img) return;
  if (img.derivatives != null) return; // already processed (or intentionally empty)

  await generateImageDerivatives(img);
}
