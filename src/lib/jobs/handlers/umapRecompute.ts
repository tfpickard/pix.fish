import { UMAP } from 'umap-js';
import type { Job } from '@/lib/db/schema';
import { allCaptionVectors } from '@/lib/db/queries/embeddings';
import { saveProjection } from '@/lib/db/queries/umap';

type Payload = { nNeighbors?: number; minDist?: number; kind?: string };

// umap-js is pure JS; above this threshold we subsample deterministically so
// the job stays inside the 60s Vercel function budget. Revisit if the gallery
// grows past this point.
const MAX_POINTS = 5000;

// Simple mulberry32 PRNG. Seeded by point count so a given run is
// reproducible: re-triggering without new uploads yields the same subsample.
function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export async function umapRecomputeHandler(job: Job): Promise<void> {
  const payload = job.payload as Payload;
  const nNeighbors = payload.nNeighbors ?? 15;
  const minDist = payload.minDist ?? 0.1;
  const kind = payload.kind ?? 'caption';

  const all = await allCaptionVectors();
  if (all.length < 4) {
    // UMAP needs at least nNeighbors+1 points to be meaningful. Persist an
    // empty projection so the read path knows the job ran.
    await saveProjection({ nNeighbors, minDist, kind }, []);
    return;
  }

  // Subsample if needed. Deterministic Fisher-Yates shuffle over the index
  // array, then take the first MAX_POINTS. Avoid `sort(() => rnd() - 0.5)`
  // which is biased (non-transitive comparator) and non-deterministic across
  // sort implementations.
  let sample = all;
  if (all.length > MAX_POINTS) {
    const rnd = mulberry32(all.length);
    const indices = all.map((_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const tmp = indices[i]!;
      indices[i] = indices[j]!;
      indices[j] = tmp;
    }
    sample = indices.slice(0, MAX_POINTS).map((i) => all[i]!);
  }

  const nbrs = Math.min(nNeighbors, sample.length - 1);
  const umap = new UMAP({ nComponents: 2, nNeighbors: nbrs, minDist });
  const coords = umap.fit(sample.map((s) => s.vec));

  const points = sample.map((s, i) => ({
    imageId: s.imageId,
    x: coords[i]![0]!,
    y: coords[i]![1]!
  }));

  await saveProjection({ nNeighbors, minDist, kind }, points);
}
