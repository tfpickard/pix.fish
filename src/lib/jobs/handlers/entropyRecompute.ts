import type { Job } from '@/lib/db/schema';
import { recomputeEntropy } from '@/lib/entropy';

// feat/hud: recompute per-image surprisal + the collection-temperature scalar.
// Enqueued (best-effort) after a successful upload so a new image shifts both
// the corpus centroid and the dispersion reading. The whole pass is read-then-
// write over existing embeddings/tags -- no model calls -- so it fits the
// <=55s job budget for any realistic corpus (large corpora use the seeded
// pairwise sample in src/lib/entropy.ts to bound the O(n^2) cost).
//
// Reuses the exact math the offline scripts/compute-entropy.ts uses; the
// shared core lives in src/lib/entropy.ts so the two never drift.
export async function entropyRecomputeHandler(_job: Job): Promise<void> {
  const result = await recomputeEntropy();
  if (result.pointCount === 0) {
    console.log('[entropy.recompute] no caption embeddings yet -- nothing to score');
    return;
  }
  // The upload route already returned 202; surface the temperature delta here
  // so it shows up in the function logs (the HUD reads the persisted row).
  const delta =
    result.previousTemperature !== null
      ? result.temperature - result.previousTemperature
      : null;
  console.log(
    `[entropy.recompute] scored ${result.surprisalWritten} image(s); ` +
      `temperature ${result.temperature.toFixed(4)} ` +
      `(delta ${delta !== null ? `${delta >= 0 ? '+' : ''}${delta.toFixed(4)}` : 'n/a, first run'}, ` +
      `points ${result.pointCount}` +
      `${result.sampledPairs !== null ? `, sampled ${result.sampledPairs} pairs` : ''})`
  );
}
