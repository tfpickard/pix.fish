// Pure taste-vector math. No DB, no Date -- deterministic and testable.
//
// A visitor's "taste vector" is the centroid of the images they were drawn to,
// pushed away from the centroid of the ones they passed on: "what pulls you,
// minus what doesn't." We then rank the gallery by nearness to that direction.
// This is the "taste is a direction, not a history" idea made literal over a
// caption-embedding space.

export function meanVector(vectors: number[][]): number[] | null {
  if (vectors.length === 0) return null;
  const dim = vectors[0]!.length;
  const out = new Array<number>(dim).fill(0);
  // Divide by the number of vectors actually summed, not the input length, so
  // a skipped mismatched-dim vector can't deflate the centroid toward zero.
  let n = 0;
  for (const v of vectors) {
    if (v.length !== dim) continue;
    for (let i = 0; i < dim; i++) out[i]! += v[i]!;
    n++;
  }
  if (n === 0) return null;
  for (let i = 0; i < dim; i++) out[i]! /= n;
  return out;
}

export function normalize(v: number[]): number[] {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  if (n === 0) return v.slice();
  return v.map((x) => x / n);
}

// taste = normalize( mean(picked) + alpha * (mean(picked) - mean(rejected)) ).
// alpha sharpens the direction away from rejected vibes; 0 falls back to the
// plain centroid when there's nothing to contrast against.
export function tasteVector(picked: number[][], rejected: number[][], alpha = 0.6): number[] | null {
  const mp = meanVector(picked);
  if (!mp) return null;
  const mr = meanVector(rejected);
  if (!mr) return normalize(mp);
  const dim = mp.length;
  const out = new Array<number>(dim);
  for (let i = 0; i < dim; i++) out[i] = mp[i]! + alpha * (mp[i]! - mr[i]!);
  return normalize(out);
}

// Cosine similarity mapped to a friendly 0-100 "alignment" score. Reserved for
// the head-to-head taste comparison (v2) but kept here so the math lives in one
// pure module.
export function alignment(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const dim = Math.min(a.length, b.length);
  for (let i = 0; i < dim; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  const cos = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return Math.round(((Math.max(-1, Math.min(1, cos)) + 1) / 2) * 100);
}
