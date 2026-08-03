import { ImageEmbedError, type ImageEmbedder } from '@/lib/ai/imageEmbed';
import {
  cropsMissingImageVec,
  recordCropImageVecFailure,
  setCropImageVec
} from '@/lib/db/queries/character-crops';

export type BackfillProgress = (msg: string) => void;

const PAGE = 500;

// Embed every character crop still missing a visual vector (Voyage multimodal)
// in one forward sweep. Shared by the offline scripts: characters:backfill-visuals
// runs it standalone, and characters:detect drains it inline before a visual/blend
// cluster (detect only writes the text vec; the visual vec is filled out-of-band,
// so a local visual sweep must backfill first or produceCandidates aborts).
//
// The queue's charactersBackfillVisualsHandler is the online counterpart -- it
// wall-budgets and re-enqueues instead of sweeping straight through, since a
// cron tick can't run unbounded.
//
// Cursor-paged by id: `afterId` advances past every crop we ATTEMPT (success or
// failure), so each crop is embedded at most once and a poisoned prefix (blobs
// deleted, so every embed fails) can't wedge the drain -- we step past it and
// reach the valid crops behind it. A crop that fails here stays NULL and is
// retried on the next run (which starts the cursor at 0 again), up to the
// per-crop attempt cap that cropsMissingImageVec enforces. Idempotent:
// setCropImageVec only writes while vec_image is still NULL.
//
// A systemic embedder failure (bad key, quota, outage) aborts the sweep rather
// than charging every crop an attempt for it -- same rule as the queue handler,
// since a local run and a cron run share the same attempt counters.
export async function backfillVisualsInline(
  embedder: ImageEmbedder,
  onProgress?: BackfillProgress
): Promise<{ ok: number; fail: number }> {
  let ok = 0;
  let fail = 0;
  let afterId = 0;
  for (;;) {
    const crops = await cropsMissingImageVec(PAGE, afterId);
    if (crops.length === 0) break;
    for (const crop of crops) {
      try {
        const vec = await embedder.embed(crop.blobUrl);
        await setCropImageVec(crop.cropId, vec, embedder.name, embedder.model);
        ok++;
        if (ok % 20 === 0) onProgress?.(`  embedded ${ok}`);
      } catch (err) {
        if (err instanceof ImageEmbedError && err.systemic) {
          throw new Error(
            `backfill aborted after ${ok} embedded -- the embedder is failing, not the crops: ${err.message}`
          );
        }
        fail++;
        await recordCropImageVecFailure(crop.cropId).catch(() => {});
        onProgress?.(`  crop ${crop.cropId} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      afterId = crop.cropId; // advance past every attempted crop, success or fail
    }
  }
  return { ok, fail };
}
