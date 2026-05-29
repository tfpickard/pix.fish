import { allCaptionVectors } from '@/lib/db/queries/embeddings';
import { meanVector } from '@/lib/ai/vector';

// Lazy, in-memory cache of the gallery's caption-embedding centroid. The
// surprise engine needs "the average vibe" to push away from; recomputing it
// from every caption vector on each request is wasteful, but a persisted cache
// (a table + recompute job) is overkill at this corpus size (~100 images).
//
// So: compute on first read, hold in a module-level var, and invalidate the
// var from the upload post-commit hook. A serverless cold start simply drops
// the cache and the next read recomputes -- correctness never depends on the
// process living forever.

let cached: number[] | null = null;
let computed = false;

export async function getGalleryCentroid(): Promise<number[] | null> {
  if (computed) return cached;
  const rows = await allCaptionVectors();
  if (rows.length === 0) {
    computed = true;
    cached = null;
    return null;
  }
  cached = meanVector(rows.map((r) => r.vec));
  computed = true;
  return cached;
}

// Called best-effort after a new caption embedding lands (see
// src/lib/enrichment-persist.ts). Clearing the flag forces a lazy recompute on
// the next read rather than recomputing inline on the upload path.
export function invalidateGalleryCentroid(): void {
  cached = null;
  computed = false;
}
