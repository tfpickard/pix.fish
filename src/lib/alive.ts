// feat/alive -- pure reproduction math.
//
// "The Fish Is Alive": images reproduce. Two parents combine into a child by
// (a) interpolating their caption embeddings to get a target point in latent
// space and (b) inheriting a blended tag set drawn from a Dirichlet mixture of
// the parents' tag distributions. This module is intentionally pure: no DB, no
// HTTP, no SDK, no randomness source other than the injectable `rng`. That
// keeps the statistical core (the Dirichlet sampler especially) reviewable and
// deterministic under test, and lets the API route's dry-run path call the same
// functions it would use for a real birth without touching the world.
//
// No em dashes anywhere, including in any string this module emits.

// Weighted centroid of two equal-length vectors: (1 - t) * a + t * b.
//
// t is the mixing weight toward b. t = 0.5 is the midpoint (plain centroid of
// two points, matching breed.ts meanVector for the 2-source case); t -> 0
// leans to parent A, t -> 1 to parent B. We clamp t to [0, 1] because an
// out-of-range weight would extrapolate past the parents, which is not what
// "a child between two parents" means.
//
// Throws on length mismatch so a caller bug surfaces loudly rather than
// producing a silently truncated vector.
export function interpolateEmbeddings(
  vecA: number[],
  vecB: number[],
  t = 0.5
): number[] {
  if (vecA.length !== vecB.length) {
    throw new Error('interpolateEmbeddings: length mismatch');
  }
  if (vecA.length === 0) {
    throw new Error('interpolateEmbeddings: empty vectors');
  }
  const w = Math.min(1, Math.max(0, t));
  const out = new Array<number>(vecA.length);
  for (let i = 0; i < vecA.length; i++) {
    out[i] = (1 - w) * vecA[i] + w * vecB[i];
  }
  return out;
}

// --- Dirichlet-sampled tag inheritance --------------------------------------
//
// The child should not just be "the union of its parents' tags," nor a coin
// flip per tag. We want a *mixture*: most of the child's character comes from
// one parent, some from the other, with the exact split varying birth to birth.
// That is precisely a Dirichlet draw.
//
// Mechanism:
//   1. Each parent contributes a tag-frequency distribution (here every parent
//      tag has weight 1; duplicates across a single parent are deduped first).
//   2. Draw a 2-vector of mixing weights w ~ Dirichlet(alpha, alpha). w sums to
//      1; alpha = 1 is the uniform-over-the-simplex prior (every split equally
//      likely), alpha > 1 concentrates toward an even 50/50 split, alpha < 1
//      pushes toward "almost all from one parent."
//   3. The child's per-tag inclusion probability is the w-weighted blend of the
//      two parents' normalized distributions. A tag both parents have gets the
//      full weight; a tag only parent A has gets only w[0] of its mass.
//   4. Include each tag independently with that probability. The result is a
//      child tag set whose size and parent-lean both vary with the Dirichlet
//      draw -- exactly the inherited-but-recombined behavior we want.

// Sample from Gamma(shape, scale = 1).
//
// We implement this without a library. Two regimes:
//   - shape >= 1: Marsaglia and Tsang's method (the standard fast, exact
//     rejection sampler). It draws a normal d and a uniform u and accepts when
//     a cheap polynomial bound holds, which it does on the large majority of
//     iterations, so the loop terminates quickly.
//   - shape < 1: draw Gamma(shape + 1) and scale by u ** (1 / shape) (the
//     standard boost trick), because Marsaglia-Tsang requires shape >= 1.
//
// The special case shape == 1 reduces to the exponential -log(U) the brief
// mentions; Marsaglia-Tsang handles it correctly too, but we keep the general
// sampler so alpha is fully tunable, not pinned to 1.
function sampleGamma(shape: number, rng: () => number): number {
  if (shape <= 0) throw new Error('sampleGamma: shape must be positive');

  if (shape < 1) {
    // Boost: Gamma(a) = Gamma(a + 1) * U ** (1 / a). Guard u away from 0 so
    // the power and the later log never see a non-finite input.
    const u = Math.max(rng(), Number.MIN_VALUE);
    return sampleGamma(shape + 1, rng) * Math.pow(u, 1 / shape);
  }

  // Marsaglia and Tsang (2000).
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  // Bounded loop: acceptance probability is high, but cap iterations so a
  // pathological rng can never hang the request.
  for (let i = 0; i < 1000; i++) {
    let x: number;
    let v: number;
    do {
      x = standardNormal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    const x2 = x * x;
    if (u < 1 - 0.0331 * x2 * x2) return d * v;
    if (Math.log(u) < 0.5 * x2 + d * (1 - v + Math.log(v))) return d * v;
  }
  // Fallback: mean of the distribution. Reaching here means the rng is
  // degenerate; returning the mean keeps the caller well-defined.
  return shape;
}

// Standard normal via Box-Muller. u1 is guarded away from 0 so log() is finite.
function standardNormal(rng: () => number): number {
  const u1 = Math.max(rng(), Number.MIN_VALUE);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// Draw w ~ Dirichlet(alpha, ..., alpha) of the given dimension via the standard
// Gamma construction: w_i = g_i / sum(g) with g_i ~ Gamma(alpha, 1). Exposed
// for testing the sampler in isolation; sampleTagsDir uses the 2-dim case.
export function sampleDirichlet(
  dim: number,
  alpha: number,
  rng: () => number = Math.random
): number[] {
  if (dim < 1) throw new Error('sampleDirichlet: dim must be >= 1');
  if (alpha <= 0) throw new Error('sampleDirichlet: alpha must be positive');
  const gammas = new Array<number>(dim);
  let sum = 0;
  for (let i = 0; i < dim; i++) {
    const g = sampleGamma(alpha, rng);
    gammas[i] = g;
    sum += g;
  }
  // All-zero draw is astronomically unlikely but would divide by zero; fall
  // back to the uniform simplex point in that case.
  if (sum <= 0) return new Array<number>(dim).fill(1 / dim);
  return gammas.map((g) => g / sum);
}

export type SampleTagsResult = {
  // The sampled child tag set, lowercased + deduped, in a stable order.
  tags: string[];
  // The Dirichlet mixing weights actually drawn, [wA, wB]. Surfaced so the
  // dry-run / result payload can show how the child leaned this birth.
  weights: [number, number];
};

// Dirichlet-sampled tag inheritance. See the block comment above for the model.
//
// `alpha` controls the mixture prior (default 1.0 == uniform over the simplex).
// `rng` is injectable so the API route can pass a seeded generator for a
// reproducible dry-run preview, and tests can pin it. Output strings carry no
// em dashes (tags are lowercased single tokens in this app anyway).
export function sampleTagsDir(
  parentATags: string[],
  parentBTags: string[],
  alpha = 1.0,
  rng: () => number = Math.random
): SampleTagsResult {
  const norm = (xs: string[]) => {
    const seen = new Set<string>();
    for (const raw of xs) {
      const t = raw.trim().toLowerCase();
      if (t) seen.add(t);
    }
    return seen;
  };
  const aSet = norm(parentATags);
  const bSet = norm(parentBTags);

  // Each parent's tag distribution is uniform over its own tags (weight 1 per
  // tag, normalized by the parent's tag count). A parent with no tags
  // contributes nothing, and its mixing weight simply has no effect.
  const aMass = aSet.size > 0 ? 1 / aSet.size : 0;
  const bMass = bSet.size > 0 ? 1 / bSet.size : 0;

  const [wA, wB] = sampleDirichlet(2, alpha, rng) as [number, number];

  const union = new Set<string>([...aSet, ...bSet]);
  // Peak blended per-tag mass: a tag both parents share at full strength. We
  // normalize inclusion probabilities against this so the most-shared tag has
  // probability ~1 and rarer tags scale down, keeping child set sizes sane
  // regardless of how many tags the parents carry.
  const peak = wA * aMass + wB * bMass;

  const chosen: string[] = [];
  for (const tag of union) {
    const blended = (aSet.has(tag) ? wA * aMass : 0) + (bSet.has(tag) ? wB * bMass : 0);
    const p = peak > 0 ? blended / peak : 0;
    if (rng() < p) chosen.push(tag);
  }

  // Guarantee a non-empty inheritance when the parents had any tags at all:
  // a child with zero tags would generate a contentless prompt. If the draw
  // happened to reject everything, keep the single highest-mass tag.
  if (chosen.length === 0 && union.size > 0) {
    let best: string | null = null;
    let bestMass = -1;
    for (const tag of union) {
      const blended = (aSet.has(tag) ? wA * aMass : 0) + (bSet.has(tag) ? wB * bMass : 0);
      if (blended > bestMass) {
        bestMass = blended;
        best = tag;
      }
    }
    if (best) chosen.push(best);
  }

  chosen.sort();
  return { tags: chosen, weights: [wA, wB] };
}

// Build a text-to-image prompt for the child from its inherited tags. Kept
// here (pure) so the dry-run can show the exact prompt a real birth would use.
// No em dashes: the ImageGenRequest contract requires it and this is the
// string that would reach a real adapter.
export function buildChildPrompt(tags: string[]): string {
  const list = tags.filter(Boolean);
  if (list.length === 0) {
    // Defensive: sampleTagsDir guarantees at least one tag when the parents
    // had any, but a tagless pair of parents is still possible.
    return 'an abstract image, offspring of two gallery images';
  }
  return `an image combining these qualities: ${list.join(', ')}`;
}

// Deterministic 32-bit seeded RNG (mulberry32). Used by the API route to make
// a dry-run preview reproducible from a seed, so the admin sees a stable
// "what would happen" before committing. Returns a function in [0, 1).
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
