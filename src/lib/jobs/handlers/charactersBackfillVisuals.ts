import { getImageEmbedder } from '@/lib/ai/imageEmbed';
import {
  countCropsMissingImageVec,
  cropsMissingImageVec,
  setCropImageVec
} from '@/lib/db/queries/character-crops';
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

type Payload = { afterId?: number };

export async function charactersBackfillVisualsHandler(job: Job): Promise<void> {
  const embedder = getImageEmbedder();
  if (!embedder) throw new Error('characters.backfill-visuals: no VOYAGE_API_KEY configured');

  // Cursor-paged by crop id. `afterId` advances past every crop we ATTEMPT
  // (success OR failure), so a poisoned prefix -- crops whose blobs were deleted
  // and always fail -- can't wedge the drain: we step past it and reach the valid
  // crops behind it, instead of re-fetching and re-failing the same ordered
  // prefix every retry until maxAttempts is spent.
  let afterId = Number((job.payload as Payload | undefined)?.afterId ?? 0);
  const startedAt = Date.now();
  let ok = 0;
  let failed = 0;
  let attempted = 0;
  let budgetHit = false;

  outer: for (;;) {
    if (Date.now() - startedAt > BUDGET_MS) {
      budgetHit = true;
      break;
    }
    const crops = await cropsMissingImageVec(BATCH, afterId);
    if (crops.length === 0) break; // reached the end of the sweep
    for (const crop of crops) {
      if (Date.now() - startedAt > BUDGET_MS) {
        budgetHit = true;
        break outer;
      }
      attempted++;
      try {
        const vec = await embedder.embed(crop.blobUrl);
        await setCropImageVec(crop.cropId, vec, embedder.name, embedder.model);
        ok++;
      } catch (err) {
        failed++;
        console.error(`characters.backfill-visuals: crop ${crop.cropId} failed`, err);
      }
      afterId = crop.cropId; // advance the cursor past this crop, success or fail
    }
  }
  console.log(
    `characters.backfill-visuals: embedded ${ok}, failed ${failed} of ${attempted} attempted (cursor ${afterId})`
  );

  if (budgetHit) {
    // Out of budget with more of the sweep ahead -- continue from the cursor.
    await enqueueJob({ type: 'characters.backfill-visuals', payload: { afterId }, maxAttempts: 3 });
    return;
  }

  // Full sweep finished. Anything still NULL is either poison (blobs gone --
  // permanent) or a crop that failed transiently this pass. Surface a nonzero
  // remainder by throwing: the retry policy re-runs THIS job with backoff, and
  // when the whole corpus fit in one invocation its payload cursor is 0, so the
  // retry re-sweeps from the start and recovers transient failures. After
  // maxAttempts a genuinely-poisoned remainder lands as a visible failed job,
  // rather than silently declaring success with crops left unembedded.
  const remaining = await countCropsMissingImageVec();
  if (remaining > 0) {
    throw new Error(
      `characters.backfill-visuals: ${remaining} crop(s) still lack a visual vector after a full sweep`
    );
  }
}
