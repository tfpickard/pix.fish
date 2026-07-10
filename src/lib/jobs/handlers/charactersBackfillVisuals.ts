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
// How many full front-to-back sweeps to attempt before giving up. Each completed
// sweep that still leaves crops NULL restarts a fresh sweep from id 0 to re-embed
// stragglers (recovering transient failures anywhere in the corpus). Bounded so a
// genuinely-poisoned crop -- blob deleted, always fails -- eventually surfaces as
// a failed job instead of restarting forever.
const MAX_SWEEPS = 3;

type Payload = { afterId?: number; sweep?: number };

export async function charactersBackfillVisualsHandler(job: Job): Promise<void> {
  const embedder = getImageEmbedder();
  if (!embedder) throw new Error('characters.backfill-visuals: no VOYAGE_API_KEY configured');

  const payload = (job.payload as Payload | undefined) ?? {};
  // Cursor-paged by crop id. `afterId` advances past every crop we ATTEMPT
  // (success OR failure), so a poisoned prefix -- crops whose blobs were deleted
  // and always fail -- can't wedge the drain: we step past it and reach the valid
  // crops behind it. `sweep` counts how many full front-to-back passes we've
  // already completed (budget continuations keep the same sweep number).
  let afterId = Number(payload.afterId ?? 0);
  const sweep = Number(payload.sweep ?? 0);
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
    if (crops.length === 0) break; // reached the end of this sweep
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
    `characters.backfill-visuals: sweep ${sweep} embedded ${ok}, failed ${failed} of ${attempted} attempted (cursor ${afterId})`
  );

  if (budgetHit) {
    // Out of budget with more of this sweep ahead -- continue from the cursor,
    // same sweep number.
    await enqueueJob({
      type: 'characters.backfill-visuals',
      payload: { afterId, sweep },
      maxAttempts: 3
    });
    return;
  }

  // Full sweep finished. Anything still NULL is either poison (blob gone --
  // permanent) or a crop that failed transiently somewhere in this pass.
  const remaining = await countCropsMissingImageVec();
  if (remaining === 0) return; // fully drained

  const nextSweep = sweep + 1;
  if (nextSweep < MAX_SWEEPS) {
    // Restart a FRESH sweep from the front (afterId 0), not from this job's end
    // cursor. Retrying this job's payload would only re-scan ids past the cursor
    // and never revisit an earlier crop that failed transiently, so a straggler
    // before the cursor would wedge visual/blend clustering despite the one-click
    // backfill. A clean restart re-attempts every still-NULL crop; embedded ones
    // are already skipped (vec_image not NULL), so only stragglers get re-tried.
    console.log(
      `characters.backfill-visuals: ${remaining} crop(s) still missing after sweep ${sweep}; restarting sweep ${nextSweep}`
    );
    await enqueueJob({
      type: 'characters.backfill-visuals',
      payload: { afterId: 0, sweep: nextSweep },
      maxAttempts: 3
    });
    return;
  }

  // Exhausted the bounded restarts and crops are still NULL -- treat the remainder
  // as poison (or a sustained outage) and throw so it surfaces as a visible failed
  // job, rather than silently leaving crops unembedded.
  throw new Error(
    `characters.backfill-visuals: ${remaining} crop(s) still lack a visual vector after ${MAX_SWEEPS} sweeps`
  );
}
