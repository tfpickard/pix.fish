// The unique, NON-heritable visual flourish each fish carries -- its fingerprint.
//
// Hard invariant: a fish's feature is a pure deterministic function of its seed,
// and seeds come from monotonically-increasing ids that are never reused. So
// every fish's flourish is collision-free BY CONSTRUCTION -- there is no runtime
// "check the others and retry". On a birth the genotype is inherited but the
// feature is regenerated from a brand-new seed, so kids resemble parents in body
// traits yet never share a parent's flourish.
//
// A feature is reduced to a small list of primitive SVG shapes in the fish's
// viewBox coordinate space ("0 0 110 65"), so the sprite component stays dumb:
// it just maps shapes to elements. Anatomy reference (clockwise): head ~x18,
// dorsal top ~x68/y4, tail ~x100/y28, belly ~y54.

import { pick, randInt, randRange, rngFromSeed, type Rng } from './prng';

export type FeatureKind =
  | 'tailSquiggle'
  | 'spineKink'
  | 'finCurl'
  | 'freckles'
  | 'topSpike'
  | 'whisker'
  | 'stripes';

export type FeatureShape =
  | { type: 'path'; d: string; strokeWidth: number; opacity: number }
  | { type: 'circle'; cx: number; cy: number; r: number; opacity: number };

export interface FishFeature {
  kind: FeatureKind;
  seed: number;
  shapes: FeatureShape[];
}

const KINDS: readonly FeatureKind[] = [
  'tailSquiggle',
  'spineKink',
  'finCurl',
  'freckles',
  'topSpike',
  'whisker',
  'stripes'
];

function n(v: number): string {
  return v.toFixed(1);
}

// A trailing squiggle streaming off the tail tip.
function tailSquiggle(rng: Rng): FeatureShape[] {
  const y = randRange(rng, 24, 32);
  const amp = randRange(rng, 3, 7);
  const len = randRange(rng, 10, 18);
  const x0 = 100;
  const d =
    `M ${n(x0)} ${n(y)} ` +
    `Q ${n(x0 + len * 0.4)} ${n(y - amp)}, ${n(x0 + len * 0.7)} ${n(y)} ` +
    `Q ${n(x0 + len)} ${n(y + amp)}, ${n(x0 + len * 1.3)} ${n(y)}`;
  return [{ type: 'path', d, strokeWidth: randRange(rng, 1.6, 2.4), opacity: 0.9 }];
}

// A short zigzag kink riding the upper back.
function spineKink(rng: Rng): FeatureShape[] {
  const x0 = randRange(rng, 38, 50);
  const yTop = randRange(rng, 8, 14);
  const step = randRange(rng, 5, 8);
  const h = randRange(rng, 4, 7);
  const d =
    `M ${n(x0)} ${n(yTop + h)} ` +
    `L ${n(x0 + step)} ${n(yTop)} ` +
    `L ${n(x0 + step * 2)} ${n(yTop + h)} ` +
    `L ${n(x0 + step * 3)} ${n(yTop)}`;
  return [{ type: 'path', d, strokeWidth: randRange(rng, 1.8, 2.6), opacity: 0.85 }];
}

// A curl spiralling off the dorsal fin tip.
function finCurl(rng: Rng): FeatureShape[] {
  const x0 = randRange(rng, 62, 74);
  const y0 = randRange(rng, 0, 4);
  const r = randRange(rng, 4, 7);
  const dir = rng() < 0.5 ? -1 : 1;
  const d =
    `M ${n(x0)} ${n(y0)} ` +
    `C ${n(x0 + dir * r)} ${n(y0 - r)}, ${n(x0 + dir * r * 1.8)} ${n(y0 + r * 0.4)}, ` +
    `${n(x0 + dir * r * 0.6)} ${n(y0 + r * 0.9)}`;
  return [{ type: 'path', d, strokeWidth: randRange(rng, 1.6, 2.2), opacity: 0.9 }];
}

// A scatter of freckle dots across the mid-body.
function freckles(rng: Rng): FeatureShape[] {
  const count = randInt(rng, 3, 6);
  const shapes: FeatureShape[] = [];
  for (let i = 0; i < count; i++) {
    shapes.push({
      type: 'circle',
      cx: randRange(rng, 30, 76),
      cy: randRange(rng, 20, 44),
      r: randRange(rng, 1, 2.2),
      opacity: randRange(rng, 0.5, 0.9)
    });
  }
  return shapes;
}

// One to three little dorsal spikes.
function topSpike(rng: Rng): FeatureShape[] {
  const count = randInt(rng, 1, 3);
  const shapes: FeatureShape[] = [];
  let x = randRange(rng, 46, 56);
  for (let i = 0; i < count; i++) {
    const h = randRange(rng, 4, 8);
    const base = randRange(rng, 9, 13);
    const w = randRange(rng, 3, 5);
    const d = `M ${n(x)} ${n(base)} L ${n(x + w / 2)} ${n(base - h)} L ${n(x + w)} ${n(base)}`;
    shapes.push({ type: 'path', d, strokeWidth: randRange(rng, 1.6, 2.2), opacity: 0.85 });
    x += w + randRange(rng, 2, 5);
  }
  return shapes;
}

// A drooping barbel/whisker off the chin.
function whisker(rng: Rng): FeatureShape[] {
  const x0 = randRange(rng, 9, 13);
  const y0 = randRange(rng, 39, 43);
  const len = randRange(rng, 8, 14);
  const droop = randRange(rng, 4, 9);
  const d =
    `M ${n(x0)} ${n(y0)} ` +
    `Q ${n(x0 - len * 0.5)} ${n(y0 + droop * 0.4)}, ${n(x0 - len)} ${n(y0 + droop)}`;
  return [{ type: 'path', d, strokeWidth: randRange(rng, 1.4, 2.0), opacity: 0.85 }];
}

// Two to four short body stripes.
function stripes(rng: Rng): FeatureShape[] {
  const count = randInt(rng, 2, 4);
  const shapes: FeatureShape[] = [];
  let x = randRange(rng, 34, 42);
  for (let i = 0; i < count; i++) {
    const yTop = randRange(rng, 18, 24);
    const yBot = randRange(rng, 42, 48);
    const bow = randRange(rng, -3, 3);
    const d = `M ${n(x)} ${n(yTop)} Q ${n(x + bow)} ${n((yTop + yBot) / 2)}, ${n(x)} ${n(yBot)}`;
    shapes.push({ type: 'path', d, strokeWidth: randRange(rng, 1.4, 2.0), opacity: 0.6 });
    x += randRange(rng, 9, 14);
  }
  return shapes;
}

const GENERATORS: Record<FeatureKind, (rng: Rng) => FeatureShape[]> = {
  tailSquiggle,
  spineKink,
  finCurl,
  freckles,
  topSpike,
  whisker,
  stripes
};

// Derive the flourish deterministically from a seed. Same seed -> identical
// feature, every time, on every client.
export function featureFromSeed(seed: number): FishFeature {
  const rng = rngFromSeed(seed);
  const kind = pick(rng, KINDS);
  return { kind, seed, shapes: GENERATORS[kind](rng) };
}
