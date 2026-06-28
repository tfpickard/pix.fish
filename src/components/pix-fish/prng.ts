// Tiny seeded PRNG for the fish sim.
//
// Two distinct needs are served here, and they must NOT share a generator:
//   1. Deterministic, reproducible randomness keyed off a fish's id/seed -- the
//      unique flourish (`feature.ts`) is derived from this so it is identical on
//      every render and collision-free by construction (ids never repeat).
//   2. Live, non-reproducible randomness for the simulation itself (event dice,
//      mutation jitter, wander targets). This just needs to be cheap and
//      decoupled from Math.random call sites elsewhere.
//
// mulberry32 is a well-known 32-bit generator: fast, tiny, good enough for
// visuals. No dependency, no crypto -- this is decoration, not security.

export type Rng = () => number;

// mulberry32 -- returns a function producing floats in [0, 1).
export function rngFromSeed(seed: number): Rng {
  // Force to a uint32 so the same `seed` always yields the same stream.
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// rng helpers -- thin, readable wrappers used across genotype/feature/events.

export function randRange(rng: Rng, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

export function randInt(rng: Rng, lo: number, hi: number): number {
  // Inclusive of both ends.
  return Math.floor(lo + rng() * (hi - lo + 1));
}

export function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

// Box-Muller standard normal, used for genotype mutation jitter.
export function randNormal(rng: Rng): number {
  // Guard against log(0) by nudging u1 off zero.
  const u1 = Math.max(rng(), 1e-9);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// A process-lived generator for the live simulation. Seeded once from a fixed
// constant so the module has no Math.random/Date.now at import time; the first
// few draws being deterministic across reloads is harmless for ambient motion.
export const simRng: Rng = rngFromSeed(0x9e3779b9);
