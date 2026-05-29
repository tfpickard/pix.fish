// Small, dependency-free vector helpers shared across embedding-driven
// features (breed, the vibe equalizer, the surprise engine, the gallery
// centroid cache). These were previously private to breed.ts; they were
// lifted out so Phase 2 playground code can reuse the exact same math instead
// of re-deriving a slightly different centroid and drifting out of sync.

// Mean (centroid) of a set of equal-length vectors. Throws on a length
// mismatch because that is always a config bug (mixed embedding models), not
// something a caller can recover from.
export function meanVector(vectors: number[][]): number[] {
  if (vectors.length === 0) {
    throw new Error('meanVector requires at least one vector.');
  }
  const dim = vectors[0]!.length;
  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    if (v.length !== dim) {
      throw new Error(`embedding length mismatch: ${v.length} vs ${dim}.`);
    }
    for (let i = 0; i < dim; i++) sum[i] += v[i]!;
  }
  const n = vectors.length;
  for (let i = 0; i < dim; i++) sum[i] = sum[i]! / n;
  return sum;
}

export function subtractVector(a: number[], b: number[]): number[] {
  if (a.length !== b.length) {
    throw new Error(`embedding length mismatch: ${a.length} vs ${b.length}.`);
  }
  const out = new Array<number>(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! - b[i]!;
  return out;
}

// Cosine similarity in [-1, 1]. Returns 0 when either vector is all-zero
// rather than dividing by zero.
export function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`embedding length mismatch: ${a.length} vs ${b.length}.`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Element-wise linear interpolation: a + t * (b - a). t is not clamped so
// callers can intentionally extrapolate past the endpoints.
export function lerpVector(a: number[], b: number[], t: number): number[] {
  if (a.length !== b.length) {
    throw new Error(`embedding length mismatch: ${a.length} vs ${b.length}.`);
  }
  const out = new Array<number>(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! + t * (b[i]! - a[i]!);
  return out;
}
