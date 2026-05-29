import { UMAP } from 'umap-js';
import type { Job } from '@/lib/db/schema';
import { allCaptionVectors } from '@/lib/db/queries/embeddings';
import { saveManifold } from '@/lib/db/queries/manifold';

type Payload = {
  nNeighbors?: number;
  minDist?: number;
  seed?: number;
  kind?: string;
};

// Subsample budget. umap-js at nComponents=3 is more compute-intensive than
// 2D; stay well under the 55s cron wall budget.
const MAX_POINTS = 3000;

// Fixed default seed stored in the DB row alongside the projection. The same
// seed + same corpus subset yields the same UMAP layout run-to-run, so an
// admin who re-triggers without uploading new images gets a visually stable
// point cloud. Use mulberry32 (same PRNG as umapRecompute) for the subsample
// shuffle AND pass the seed to umap-js via its random number source.
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

export async function manifoldRecomputeHandler(job: Job): Promise<void> {
  const payload = job.payload as Payload;
  const nNeighbors = payload.nNeighbors ?? 15;
  const minDist = payload.minDist ?? 0.1;
  // Seed is stored once here and carried into the DB row so future callers can
  // reproduce the exact layout without re-reading it from payload vs. row.
  const seed = payload.seed ?? 42;
  const kind = payload.kind ?? 'caption';

  const all = await allCaptionVectors();
  if (all.length < 4) {
    // Too few points for a meaningful projection; persist an empty row so the
    // read path knows the job ran.
    await saveManifold(seed, { nNeighbors, minDist, seed, kind }, []);
    return;
  }

  // Deterministic subsample. Use the seed (not point count) so the same seed
  // always picks the same subset regardless of corpus size changes between runs.
  // The same rng instance drives the shuffle AND is passed to umap-js so both
  // random stages are reproducible from a single seed.
  const rng = mulberry32(seed);
  let sample = all;
  if (all.length > MAX_POINTS) {
    const indices = all.map((_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = indices[i]!;
      indices[i] = indices[j]!;
      indices[j] = tmp;
    }
    sample = indices.slice(0, MAX_POINTS).map((i) => all[i]!);
  }

  const nbrs = Math.min(nNeighbors, sample.length - 1);
  const umap = new UMAP({
    nComponents: 3,
    nNeighbors: nbrs,
    minDist,
    // Pass the seeded RNG to umap-js so the stochastic optimization phase is
    // reproducible. The library accepts a `random` option for exactly this use.
    random: rng
  });
  const coords = umap.fit(sample.map((s) => s.vec));

  const points = sample.map((s, i) => ({
    imageId: s.imageId,
    x: coords[i]![0]!,
    y: coords[i]![1]!,
    z: coords[i]![2]!
  }));

  await saveManifold(seed, { nNeighbors, minDist, seed, kind }, points);
}
