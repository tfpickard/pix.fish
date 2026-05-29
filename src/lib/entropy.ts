import { allCaptionVectors } from '@/lib/db/queries/embeddings';
import { db } from '@/lib/db/client';
import { images, tags } from '@/lib/db/schema';
import { eq, sql } from 'drizzle-orm';

// Shared entropy core. Both scripts/compute-entropy.ts (offline batch) and
// the entropy.recompute job handler call recomputeEntropy() so the math lives
// in exactly one place. Everything here is deterministic: no randomness, no
// time-of-day input, so the same corpus always yields the same surprisal +
// temperature. Pairwise sampling (below) is seeded, so even that is stable.

// Blend weight: surprisal = W_CENTROID * centroidComponent + (1 - W_CENTROID)
// * rarityComponent. Both components are min-max normalized across the corpus
// to [0,1] first, so neither the embedding-distance scale nor the tag-rarity
// scale dominates the other. 0.5 weights "looks unlike the average image"
// and "is described with rare words" equally; surprise should reward both an
// odd picture and an odd vocabulary.
export const W_CENTROID = 0.5;

// Above this corpus size we stop computing exact O(n^2) mean pairwise cosine
// distance for the collection temperature and switch to a deterministic
// sampled estimate. 1500 points => ~1.1M pairs, which is the ceiling we want
// to do inline in a <=55s job. The sample size is recorded in meta.
const PAIRWISE_EXACT_MAX = 1500;
// Number of deterministic pairs to sample when the corpus is larger. Drawn
// with a seeded LCG so the estimate is reproducible run-to-run.
const PAIRWISE_SAMPLE_PAIRS = 200_000;

type Vec = number[];

function dot(a: Vec, b: Vec): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

function norm(a: Vec): number {
  return Math.sqrt(dot(a, a));
}

// Cosine distance in [0, 2]; 0 means identical direction. A zero-length
// vector (degenerate embedding) is treated as maximally distant so it can't
// silently read as "identical to everything."
function cosineDistance(a: Vec, b: Vec, normA: number, normB: number): number {
  if (normA === 0 || normB === 0) return 1;
  const cos = dot(a, b) / (normA * normB);
  // Clamp for float error so distance never escapes [0, 2].
  const clamped = Math.max(-1, Math.min(1, cos));
  return 1 - clamped;
}

function centroidOf(vecs: Vec[]): Vec {
  const dim = vecs[0]!.length;
  const c = new Array<number>(dim).fill(0);
  for (const v of vecs) {
    for (let i = 0; i < dim; i++) c[i]! += v[i]!;
  }
  for (let i = 0; i < dim; i++) c[i]! /= vecs.length;
  return c;
}

// Min-max normalize to [0,1]. A flat input (all equal) maps to all-zeros so a
// degenerate component contributes nothing rather than NaN.
function minMaxNormalize(values: number[]): number[] {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  if (range === 0) return values.map(() => 0);
  return values.map((v) => (v - min) / range);
}

// Deterministic LCG so the sampled temperature estimate is reproducible.
// Numerical Recipes constants; seed is fixed so two runs over the same corpus
// agree.
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export type EntropyResult = {
  // imageId -> surprisal in [0,1]. Only images with a caption embedding are
  // scored; everything else is left null (callers must not zero them out).
  surprisalById: Map<number, number>;
  // Mean pairwise cosine distance over the embedded corpus, plus provenance.
  temperature: number;
  pointCount: number;
  sampledPairs: number | null; // null = exact computation
  // Mean cosine distance from each image to the corpus centroid -- a cheaper
  // sibling of temperature, recorded in meta for context.
  meanCentroidDistance: number;
};

// Per-image tag rows keyed by imageId. Passed in so callers control the read
// (the script reads all rows once; the handler does the same).
export type TagRow = { imageId: number; tag: string };

// Pure: given the embedded corpus and the tag rows, produce surprisal +
// temperature. No DB access here so it is trivially testable and so the two
// callers share identical math.
export function computeEntropy(
  vectors: { imageId: number; vec: Vec }[],
  tagRows: TagRow[]
): EntropyResult {
  const surprisalById = new Map<number, number>();

  if (vectors.length === 0) {
    return {
      surprisalById,
      temperature: 0,
      pointCount: 0,
      sampledPairs: null,
      meanCentroidDistance: 0
    };
  }

  // --- Component A: distance from the corpus centroid -----------------------
  const vecs = vectors.map((v) => v.vec);
  const centroid = centroidOf(vecs);
  const centroidNorm = norm(centroid);
  const vecNorms = vecs.map((v) => norm(v));
  const centroidDistances = vectors.map((_, i) =>
    cosineDistance(vecs[i]!, centroid, vecNorms[i]!, centroidNorm)
  );
  const meanCentroidDistance =
    centroidDistances.reduce((a, b) => a + b, 0) / centroidDistances.length;

  // --- Component B: tag rarity = sum of -log(p(tag)) over the image's tags --
  // p(tag) = (images carrying that tag) / (total images that have >=1 tag).
  // Using document frequency (one count per image, not per duplicate) keeps a
  // single repeated tag from skewing the probability. An image with no tags
  // gets rarity 0 -- absence of vocabulary is not "surprising vocabulary."
  const tagsByImage = new Map<number, Set<string>>();
  for (const r of tagRows) {
    let set = tagsByImage.get(r.imageId);
    if (!set) {
      set = new Set();
      tagsByImage.set(r.imageId, set);
    }
    set.add(r.tag);
  }
  const docFreq = new Map<string, number>();
  for (const set of tagsByImage.values()) {
    for (const tag of set) docFreq.set(tag, (docFreq.get(tag) ?? 0) + 1);
  }
  const taggedImageCount = tagsByImage.size;
  const rarityRaw = vectors.map(({ imageId }) => {
    const set = tagsByImage.get(imageId);
    if (!set || set.size === 0 || taggedImageCount === 0) return 0;
    let sum = 0;
    for (const tag of set) {
      const p = (docFreq.get(tag) ?? 1) / taggedImageCount;
      sum += -Math.log(p);
    }
    return sum;
  });

  // --- Normalize each component to [0,1] then blend -------------------------
  const centroidNorm01 = minMaxNormalize(centroidDistances);
  const rarityNorm01 = minMaxNormalize(rarityRaw);
  for (let i = 0; i < vectors.length; i++) {
    const blended = W_CENTROID * centroidNorm01[i]! + (1 - W_CENTROID) * rarityNorm01[i]!;
    surprisalById.set(vectors[i]!.imageId, blended);
  }

  // --- Collection temperature: mean pairwise cosine distance ---------------
  const { temperature, sampledPairs } = meanPairwiseDistance(vecs, vecNorms);

  return {
    surprisalById,
    temperature,
    pointCount: vectors.length,
    sampledPairs,
    meanCentroidDistance
  };
}

// Mean pairwise cosine distance. Exact for small corpora; for large ones a
// deterministic seeded sample keeps the cost bounded. The sample count is
// returned so it can be recorded in collection_temperature.meta.
function meanPairwiseDistance(
  vecs: Vec[],
  vecNorms: number[]
): { temperature: number; sampledPairs: number | null } {
  const n = vecs.length;
  if (n < 2) return { temperature: 0, sampledPairs: null };

  if (n <= PAIRWISE_EXACT_MAX) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        sum += cosineDistance(vecs[i]!, vecs[j]!, vecNorms[i]!, vecNorms[j]!);
        count++;
      }
    }
    return { temperature: count > 0 ? sum / count : 0, sampledPairs: null };
  }

  // Seeded sampling: fixed seed so the estimate is reproducible. Self-pairs
  // are rejected; ordering doesn't matter for an undirected distance.
  const rng = makeRng(0x5eed1234);
  let sum = 0;
  let count = 0;
  for (let k = 0; k < PAIRWISE_SAMPLE_PAIRS; k++) {
    const i = Math.floor(rng() * n);
    let j = Math.floor(rng() * n);
    if (i === j) j = (j + 1) % n;
    sum += cosineDistance(vecs[i]!, vecs[j]!, vecNorms[i]!, vecNorms[j]!);
    count++;
  }
  return { temperature: count > 0 ? sum / count : 0, sampledPairs: count };
}

// Persist surprisal to images.surprisal. Only writes rows present in the map
// (embedded images); unscored rows keep their existing value (typically null)
// so the surprising-first sort treats them as least surprising.
export async function persistSurprisal(surprisalById: Map<number, number>): Promise<number> {
  let written = 0;
  for (const [imageId, value] of surprisalById) {
    await db.update(images).set({ surprisal: value }).where(eq(images.id, imageId));
    written++;
  }
  return written;
}

// Insert one collection_temperature row so dispersion history accrues. Returns
// the previous row's value (or null) so callers can report the delta.
export async function recordTemperature(result: EntropyResult): Promise<{ previous: number | null }> {
  const prev = await db.execute<{ value: number }>(sql`
    SELECT value FROM collection_temperature ORDER BY computed_at DESC LIMIT 1
  `);
  const previous = prev.rows[0]?.value ?? null;
  await db.execute(sql`
    INSERT INTO collection_temperature (value, point_count, meta)
    VALUES (
      ${result.temperature},
      ${result.pointCount},
      ${JSON.stringify({
        meanCentroidDistance: result.meanCentroidDistance,
        sampledPairs: result.sampledPairs,
        blendWeightCentroid: W_CENTROID
      })}::jsonb
    )
  `);
  return { previous: previous !== null ? Number(previous) : null };
}

// Read all (imageId, tag) rows. One query; callers pass the result into
// computeEntropy so the pure core stays DB-free.
export async function loadTagRows(): Promise<TagRow[]> {
  const rows = await db.select({ imageId: tags.imageId, tag: tags.tag }).from(tags);
  return rows.map((r) => ({ imageId: r.imageId, tag: r.tag }));
}

// End-to-end recompute used by both the script and the job handler:
// read corpus -> compute -> persist surprisal -> record temperature.
// Returns the result plus the temperature delta vs the previous row.
export async function recomputeEntropy(): Promise<
  EntropyResult & { previousTemperature: number | null; surprisalWritten: number }
> {
  const [vectors, tagRows] = await Promise.all([allCaptionVectors(), loadTagRows()]);
  const result = computeEntropy(vectors, tagRows);
  const surprisalWritten = await persistSurprisal(result.surprisalById);
  const { previous } = await recordTemperature(result);
  return { ...result, previousTemperature: previous, surprisalWritten };
}
