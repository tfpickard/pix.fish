// Pure in-memory reorder algorithms for sorts that can't be expressed as a
// simple ORDER BY. They consume { image, embedding } pairs so the DB query
// lives in src/lib/db/queries/images.ts. Images without a caption embedding
// fall back to recency order inside each algorithm, so the feature is safe
// to ship before all rows are backfilled.

import type { Image } from '../db/schema';

export type Candidate<I extends Image = Image> = {
  image: I;
  embedding: number[] | null;
};

// Deterministic PRNG (mulberry32) so seeded modes are stable between
// server and any possible future client-side preview.
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFromString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Cosine distance in [0, 2]. Vectors that are undefined or mis-sized are
// treated as maximally distant -- they don't pull the sequence toward them
// or cluster into anyone else's neighborhood.
export function cosineDistance(a: number[] | null, b: number[] | null): number {
  if (!a || !b || a.length !== b.length) return 2;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 2;
  const sim = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return 1 - sim;
}

// MMR-style greedy reorder. Starts with the first item (already in the
// caller's desired base order, e.g. newest first) and repeatedly picks the
// next item that scores highest on:
//   alpha * (1 - rank_norm) + (1 - alpha) * min_dist_to_last_K
// where rank_norm is the candidate's position in the base order normalized
// to [0, 1]. alpha ~= 0.65 keeps the overall shape recency-biased while
// still punishing back-to-back near-duplicates.
export function drift<I extends Image>(
  items: Candidate<I>[],
  opts: { alpha?: number; lookback?: number } = {}
): I[] {
  if (items.length < 2) return items.map((c) => c.image);
  const alpha = opts.alpha ?? 0.65;
  const K = Math.max(1, opts.lookback ?? 3);

  const remaining = items.slice();
  const picked: Candidate<I>[] = [];
  picked.push(remaining.shift()!);

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i]!;
      const rankNorm = i / Math.max(1, remaining.length - 1);
      const recencyScore = 1 - rankNorm;
      let minDist = 2;
      const lookbackStart = Math.max(0, picked.length - K);
      for (let j = lookbackStart; j < picked.length; j++) {
        const d = cosineDistance(cand.embedding, picked[j]!.embedding);
        if (d < minDist) minDist = d;
      }
      // Normalize cosine distance (0..2) to 0..1 so the two terms live on
      // comparable scales.
      const dispersionScore = minDist / 2;
      const score = alpha * recencyScore + (1 - alpha) * dispersionScore;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    picked.push(remaining.splice(bestIdx, 1)[0]!);
  }
  return picked.map((c) => c.image);
}

// Chain-cluster: start with the first item, then repeatedly append the
// unused item nearest to the tail. If the nearest distance crosses the
// threshold we close the cluster and start a new one from the next unused
// item in the caller's base order (newest-first gets clusters led by the
// freshest image).
export function clump<I extends Image>(
  items: Candidate<I>[],
  opts: { breakAt?: number } = {}
): I[] {
  if (items.length < 2) return items.map((c) => c.image);
  const breakAt = opts.breakAt ?? 0.55;
  const out: Candidate<I>[] = [];
  const pool = items.slice();
  while (pool.length > 0) {
    const seed = pool.shift()!;
    out.push(seed);
    while (pool.length > 0) {
      let bestIdx = -1;
      let bestDist = Infinity;
      const tail = out[out.length - 1]!;
      for (let i = 0; i < pool.length; i++) {
        const d = cosineDistance(tail.embedding, pool[i]!.embedding);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      if (bestIdx < 0 || bestDist > breakAt) break;
      out.push(pool.splice(bestIdx, 1)[0]!);
    }
  }
  return out.map((c) => c.image);
}

// Global farthest-point traversal. Seed with the first item, then each next
// pick maximizes "minimum distance to anything already placed" over the
// remaining pool. Produces a maximally spread sequence.
export function antiClump<I extends Image>(items: Candidate<I>[]): I[] {
  if (items.length < 2) return items.map((c) => c.image);
  const picked: Candidate<I>[] = [items[0]!];
  const remaining = items.slice(1);
  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestMinDist = -1;
    for (let i = 0; i < remaining.length; i++) {
      let minDist = Infinity;
      for (const p of picked) {
        const d = cosineDistance(remaining[i]!.embedding, p.embedding);
        if (d < minDist) minDist = d;
      }
      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        bestIdx = i;
      }
    }
    picked.push(remaining.splice(bestIdx, 1)[0]!);
  }
  return picked.map((c) => c.image);
}

// A seeded random walk through embedding space. Starts at a random item,
// then steps to one of the top-5 nearest unvisited neighbors. A ~10%
// chance of a long jump picks a random unvisited item instead.
export function drunkardsWalk<I extends Image>(
  items: Candidate<I>[],
  opts: { seed: string; jumpChance?: number; neighborK?: number }
): I[] {
  if (items.length < 2) return items.map((c) => c.image);
  const rand = mulberry32(seedFromString(opts.seed));
  const jumpChance = opts.jumpChance ?? 0.1;
  const neighborK = opts.neighborK ?? 5;

  const pool = items.slice();
  const startIdx = Math.floor(rand() * pool.length);
  const walk: Candidate<I>[] = [pool.splice(startIdx, 1)[0]!];

  while (pool.length > 0) {
    const tail = walk[walk.length - 1]!;
    if (rand() < jumpChance) {
      const idx = Math.floor(rand() * pool.length);
      walk.push(pool.splice(idx, 1)[0]!);
      continue;
    }
    // Score every remaining candidate by distance to the tail, pick among
    // the closest K.
    const scored = pool.map((c, i) => ({ i, d: cosineDistance(tail.embedding, c.embedding) }));
    scored.sort((a, b) => a.d - b.d);
    const top = scored.slice(0, Math.min(neighborK, scored.length));
    const pick = top[Math.floor(rand() * top.length)]!;
    walk.push(pool.splice(pick.i, 1)[0]!);
  }
  return walk.map((c) => c.image);
}

// Interleave newest and oldest. Caller is expected to pass rows in newest-
// first order; we split head/tail and zip. Odd-length lists place the
// middle item last.
export function tidal<I extends Image>(items: I[]): I[] {
  if (items.length < 3) return items.slice();
  const out: I[] = [];
  let left = 0;
  let right = items.length - 1;
  let fromLeft = true;
  while (left <= right) {
    out.push(items[fromLeft ? left++ : right--]!);
    fromLeft = !fromLeft;
  }
  return out;
}

// Seeded in-memory shuffle. Used as a fallback when we have a seed but no
// need for a SQL-side setseed dance (e.g. small candidate windows).
export function seededShuffle<T>(items: T[], seed: string): T[] {
  const rand = mulberry32(seedFromString(seed));
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
