import { getImageEmbedder } from '@/lib/ai/imageEmbed';
import { cropsMissingImageVec, setCropImageVec } from '@/lib/db/queries/character-crops';
import { enqueueJob } from '@/lib/db/queries/jobs';
import type { Job } from '@/lib/db/schema';

// Admin-triggered visual-vector backfill. Embeds a batch of crops that lack a
// vec_image (Voyage multimodal) and re-enqueues itself while more remain, so a
// large corpus drains over successive cron ticks without a local script. Runs
// server-side, where VOYAGE_API_KEY + blob access live. Idempotent: only touches
// crops still missing a visual vector.
const BATCH = 25;

export async function charactersBackfillVisualsHandler(job: Job): Promise<void> {
  const embedder = getImageEmbedder();
  if (!embedder) throw new Error('characters.backfill-visuals: no VOYAGE_API_KEY configured');

  const crops = await cropsMissingImageVec(BATCH);
  if (crops.length === 0) return; // done

  let ok = 0;
  for (const crop of crops) {
    try {
      const vec = await embedder.embed(crop.blobUrl);
      await setCropImageVec(crop.cropId, vec, embedder.name, embedder.model);
      ok++;
    } catch (err) {
      console.error(`characters.backfill-visuals: crop ${crop.cropId} failed`, err);
    }
  }
  const failed = crops.length - ok;
  console.log(`characters.backfill-visuals: embedded ${ok}, failed ${failed} of ${crops.length}`);

  // Zero progress on a non-empty batch is likely a transient outage (Voyage/blob
  // down). Throw so the job's own retry policy re-attempts with backoff, and
  // after maxAttempts surfaces as a failed job -- rather than silently declaring
  // success and leaving crops unembedded until a human clicks again.
  if (ok === 0) {
    throw new Error(`characters.backfill-visuals: 0/${crops.length} embedded (transient outage?)`);
  }

  // We made progress AND work remains -- a full batch (more rows beyond it) or
  // failures that left rows still NULL. Enqueue a follow-up so the corpus fully
  // drains without another manual click. (A persistent poison crop eventually
  // lands in a batch alone, hits ok===0, and stops via the throw above.)
  if (crops.length === BATCH || failed > 0) {
    await enqueueJob({ type: 'characters.backfill-visuals', payload: {}, maxAttempts: 3 });
  }
}
