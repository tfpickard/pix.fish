// The HERITABLE trait vector for a fish. Offspring blend their parents' genotypes
// and mutate slightly, so kids visibly RESEMBLE their parents. This is distinct
// from the non-heritable `feature` (feature.ts), the unique seed-derived flourish
// that is regenerated fresh on every birth and never inherited.
//
// Every trait is a bounded scalar. `clampGenotype` is applied after blend/mutate
// so a long lineage of mutations can never drift a trait out of its sane range.

import type { FishMorphConfig } from '@/lib/fish/config';
import { BOIDS_DEFAULTS, MUTATION_RATE, MUTATION_SCALE } from './sim-config';
import { randNormal, randRange, type Rng } from './prng';

export interface BoidsWeights {
  separation: number;
  alignment: number;
  cohesion: number;
}

export interface FishGenotype {
  // Overall size multiplier. Predation compares baseSize * breathing.
  baseSize: number;
  // Scales the squash/warp/skew amounts of the global morph config (0..~1.6).
  morphIntensity: number;
  // Multiplies the global Lorenz drift speed (lazier vs. twitchier morphing).
  lorenzSpeed: number;
  // Boids steering weights (the fish's social style).
  boids: BoidsWeights;
  // -1 = pure prey (flees larger), +1 = pure predator (chases smaller).
  temperament: number;
  // 0..1 -- emigration eligibility and wander strength.
  wanderlust: number;
  // 0..1 -- gain on cohesion/alignment (schooler vs. loner).
  sociability: number;
}

interface Bound {
  min: number;
  max: number;
}

// Per-trait sane bounds. Mutation/blend results are clamped to these.
const BOUNDS = {
  baseSize: { min: 0.7, max: 1.7 },
  morphIntensity: { min: 0.3, max: 1.6 },
  lorenzSpeed: { min: 0.5, max: 1.8 },
  separation: { min: 0.4, max: 2.6 },
  alignment: { min: 0.1, max: 1.8 },
  cohesion: { min: 0.1, max: 1.6 },
  temperament: { min: -1, max: 1 },
  wanderlust: { min: 0, max: 1 },
  sociability: { min: 0, max: 1 }
} satisfies Record<string, Bound>;

function clamp(v: number, b: Bound): number {
  return Math.max(b.min, Math.min(b.max, v));
}

function clampGenotype(g: FishGenotype): FishGenotype {
  return {
    baseSize: clamp(g.baseSize, BOUNDS.baseSize),
    morphIntensity: clamp(g.morphIntensity, BOUNDS.morphIntensity),
    lorenzSpeed: clamp(g.lorenzSpeed, BOUNDS.lorenzSpeed),
    boids: {
      separation: clamp(g.boids.separation, BOUNDS.separation),
      alignment: clamp(g.boids.alignment, BOUNDS.alignment),
      cohesion: clamp(g.boids.cohesion, BOUNDS.cohesion)
    },
    temperament: clamp(g.temperament, BOUNDS.temperament),
    wanderlust: clamp(g.wanderlust, BOUNDS.wanderlust),
    sociability: clamp(g.sociability, BOUNDS.sociability)
  };
}

// A fresh, random genotype -- used for the founder fish and immigrants.
export function randomGenotype(rng: Rng): FishGenotype {
  return clampGenotype({
    baseSize: randRange(rng, 0.85, 1.25),
    morphIntensity: randRange(rng, 0.7, 1.25),
    lorenzSpeed: randRange(rng, 0.75, 1.3),
    boids: {
      separation: BOIDS_DEFAULTS.separation * randRange(rng, 0.6, 1.5),
      alignment: BOIDS_DEFAULTS.alignment * randRange(rng, 0.5, 1.6),
      cohesion: BOIDS_DEFAULTS.cohesion * randRange(rng, 0.5, 1.6)
    },
    temperament: randRange(rng, -0.8, 0.8),
    wanderlust: randRange(rng, 0.1, 0.9),
    sociability: randRange(rng, 0.1, 0.9)
  });
}

// Blend two parents -- per-trait random interpolation so siblings differ.
export function blendGenotype(a: FishGenotype, b: FishGenotype, rng: Rng): FishGenotype {
  const mix = (x: number, y: number) => {
    const t = rng();
    return x + (y - x) * t;
  };
  return clampGenotype({
    baseSize: mix(a.baseSize, b.baseSize),
    morphIntensity: mix(a.morphIntensity, b.morphIntensity),
    lorenzSpeed: mix(a.lorenzSpeed, b.lorenzSpeed),
    boids: {
      separation: mix(a.boids.separation, b.boids.separation),
      alignment: mix(a.boids.alignment, b.boids.alignment),
      cohesion: mix(a.boids.cohesion, b.boids.cohesion)
    },
    temperament: mix(a.temperament, b.temperament),
    wanderlust: mix(a.wanderlust, b.wanderlust),
    sociability: mix(a.sociability, b.sociability)
  });
}

// Mutate a genotype in place-free fashion. Each trait independently mutates with
// probability MUTATION_RATE; the nudge is a gaussian scaled by MUTATION_SCALE
// times the trait's range, so a fixed scale behaves sensibly per trait.
export function mutateGenotype(
  g: FishGenotype,
  rng: Rng,
  rate = MUTATION_RATE,
  scale = MUTATION_SCALE
): FishGenotype {
  const jitter = (v: number, b: Bound) => {
    if (rng() > rate) return v;
    return v + randNormal(rng) * scale * (b.max - b.min);
  };
  return clampGenotype({
    baseSize: jitter(g.baseSize, BOUNDS.baseSize),
    morphIntensity: jitter(g.morphIntensity, BOUNDS.morphIntensity),
    lorenzSpeed: jitter(g.lorenzSpeed, BOUNDS.lorenzSpeed),
    boids: {
      separation: jitter(g.boids.separation, BOUNDS.separation),
      alignment: jitter(g.boids.alignment, BOUNDS.alignment),
      cohesion: jitter(g.boids.cohesion, BOUNDS.cohesion)
    },
    temperament: jitter(g.temperament, BOUNDS.temperament),
    wanderlust: jitter(g.wanderlust, BOUNDS.wanderlust),
    sociability: jitter(g.sociability, BOUNDS.sociability)
  });
}

// Build the EFFECTIVE per-fish morph config by modulating the global config with
// this fish's genotype. The Lorenz kernel + deriveMorph are reused unchanged --
// they just receive a per-fish config. baseSize is applied separately at the
// transform stage (it also feeds predation), so it is NOT folded in here.
export function applyGenotypeToConfig(
  g: FishGenotype,
  base: FishMorphConfig
): FishMorphConfig {
  return {
    ...base,
    lorenzSpeed: base.lorenzSpeed * g.lorenzSpeed,
    squashAmount: base.squashAmount * g.morphIntensity,
    skewAmount: base.skewAmount * g.morphIntensity,
    warpAmount: base.warpAmount * g.morphIntensity
  };
}
