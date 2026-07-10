import { getImageEmbedder } from '@/lib/ai/imageEmbed';
import { cropsMissingImageVec, setCropImageVec } from '@/lib/db/queries/character-crops';
import { enqueueJob } from '@/lib/db/queries/jobs';
import type { Job } from '@/lib/db/schema';

// Admin-triggered visual-vector backfill. Embeds crops that lack a vec_image
// (Voyage multimodal) up to a wall-clock budget, then re-enqueues itself while
// more remain, so a large corpus drains across ticks without a local script.
// Runs server-side, where VOYAGE_API_KEY + blob access live. Idempotent: only
// touches crops still missing a visual vector.
const BATCH = 25;
// Stop embedding past this and re-enqueue, so a batch of slow Voyage calls can't
// blow the 45s worker budget before scheduling the next batch. Leaves headroom
// for one in-flight call (aborts at 15s) under the budget.
const BUDGET_MS = 25_000;

export async function charactersBackfillVisualsHandler(job: Job): Promise<void> {
  const embedder = getImageEmbedder();
  if (!embedder) throw new Error('characters.backfill-visuals: no VOYAGE_API_KEY configured');

  const crops = await cropsMissingImageVec(BATCH);
  if (crops.length === 0) return; // done

  const startedAt = Date.now();
  let ok = 0;
  let processed = 0;
  for (const crop of crops) {
    if (Date.now() - startedAt > BUDGET_MS) break; // out of budget -- re-enqueue the rest
    processed++;
    try {
      const vec = await embedder.embed(crop.blobUrl);
      await setCropImageVec(crop.cropId, vec, embedder.name, embedder.model);
      ok++;
    } catch (err) {
      console.error(`characters.backfill-visuals: crop ${crop.cropId} failed`, err);
    }
  }
  const failed = processed - ok;
  console.log(`characters.backfill-visuals: embedded ${ok}, failed ${failed} of ${processed} attempted`);

  // Zero progress on a batch we actually attempted is likely a transient outage
  // (Voyage/blob down). Throw so the job's retry policy re-attempts with backoff
  // and, after maxAttempts, surfaces a failed job -- rather than silently
  // declaring success and leaving crops unembedded until a human clicks again.
  if (processed > 0 && ok === 0) {
    throw new Error(`characters.backfill-visuals: 0/${processed} embedded (transient outage?)`);
  }

  // Work remains when we made progress and either didn't reach the end of the
  // batch (budget hit), the batch was full (more rows beyond it), or some rows
  // failed and stayed NULL. Re-enqueue so the corpus fully drains without another
  // click. (A persistent poison crop eventually lands in a batch alone, hits
  // ok===0, and stops via the throw above.)
  const drainedBatch = processed < crops.length || crops.length === BATCH || failed > 0;
  if (ok > 0 && drainedBatch) {
    await enqueueJob({ type: 'characters.backfill-visuals', payload: {}, maxAttempts: 3 });
  }
}
