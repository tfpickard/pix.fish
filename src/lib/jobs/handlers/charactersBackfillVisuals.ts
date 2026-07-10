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
  console.log(`characters.backfill-visuals: embedded ${ok}/${crops.length}`);

  // More likely remain (full batch) and we made progress: enqueue a follow-up
  // to continue draining (the cron may claim and run it in the same invocation
  // if its wall budget allows, or on a later one). If a full batch made zero
  // progress (all failed), stop rather than loop.
  if (crops.length === BATCH && ok > 0) {
    await enqueueJob({ type: 'characters.backfill-visuals', payload: {}, maxAttempts: 3 });
  }
}
