// The discrete life-event scheduler's brain: given a population snapshot, decide
// which event (if any) fires. Pure -- no DOM, no React, no timers. The hook owns
// the clock and the execution; this module only weighs and picks.
//
// Population is shaped toward ~N(POP_MEAN, POP_SIGMA) clamped [POP_MIN, POP_MAX]
// by biasing event weights with population PRESSURE (mean - count): below the
// mean, births are favored; above it, removals are. Two-parent reproduction is
// favored over budding; budding is boosted hard at critically low counts as an
// anti-extinction failsafe. Removals are never offered at or below POP_MIN, so
// the tank can never empty.

import type { EntityRuntime } from './entity';
import { pick, randInt, type Rng } from './prng';
import {
  ALLOW_IMMIGRATION,
  BREED_PROXIMITY,
  BUD_BASE_PROB,
  BUD_LOWPOP_BOOST,
  BUD_LOWPOP_THRESHOLD,
  EMIGRATION_BASE_WEIGHT,
  EMIGRATION_WANDERLUST_MIN,
  IMMIGRATION_BASE_WEIGHT,
  LITTER_MAX,
  LITTER_MIN,
  POP_MAX,
  POP_MEAN,
  POP_MIN,
  POP_PRESSURE_GAIN,
  PREDATION_OVERLAP,
  PREDATION_SIZE_RATIO,
  TWO_PARENT_BIAS
} from './sim-config';

export type LifeEvent =
  | { type: 'birth-two-parent'; parentA: number; parentB: number; litter: number }
  | { type: 'birth-budding'; parent: number }
  | { type: 'immigration' }
  | { type: 'predation'; predator: number; prey: number }
  | { type: 'emigration'; fish: number }
  | { type: 'none' };

interface Candidate {
  event: LifeEvent;
  weight: number;
}

function dist(a: EntityRuntime, b: EntityRuntime): number {
  return Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y);
}

export function selectEvent(rts: EntityRuntime[], now: number, rng: Rng): LifeEvent {
  const count = rts.length;
  const pressure = POP_MEAN - count;
  const birthBias = Math.exp(POP_PRESSURE_GAIN * pressure);
  const deathBias = Math.exp(-POP_PRESSURE_GAIN * pressure);

  const candidates: Candidate[] = [];

  const offReproCooldown = rts.filter((r) => now >= r.reproCooldownUntil && !r.emigrating);

  // Birth, two-parent: a proximate pair both off cooldown. Favored path.
  if (count < POP_MAX && offReproCooldown.length >= 2) {
    let best: { a: EntityRuntime; b: EntityRuntime; d: number } | null = null;
    for (let i = 0; i < offReproCooldown.length; i++) {
      for (let j = i + 1; j < offReproCooldown.length; j++) {
        const d = dist(offReproCooldown[i], offReproCooldown[j]);
        if (d <= BREED_PROXIMITY && (!best || d < best.d)) {
          best = { a: offReproCooldown[i], b: offReproCooldown[j], d };
        }
      }
    }
    if (best) {
      candidates.push({
        event: {
          type: 'birth-two-parent',
          parentA: best.a.id,
          parentB: best.b.id,
          litter: randInt(rng, LITTER_MIN, LITTER_MAX)
        },
        weight: TWO_PARENT_BIAS * birthBias
      });
    }
  }

  // Birth, budding: a single off-cooldown fish. Low base, boosted when critical.
  if (count < POP_MAX && offReproCooldown.length >= 1) {
    const lowBoost = count <= BUD_LOWPOP_THRESHOLD ? BUD_LOWPOP_BOOST : 1;
    candidates.push({
      event: { type: 'birth-budding', parent: pick(rng, offReproCooldown).id },
      weight: BUD_BASE_PROB * birthBias * lowBoost
    });
  }

  // Immigration: a stray swims in.
  if (ALLOW_IMMIGRATION && count < POP_MAX) {
    candidates.push({ event: { type: 'immigration' }, weight: IMMIGRATION_BASE_WEIGHT * birthBias });
  }

  // Predation: a big fish overlapping a much smaller neighbor. Removal -> guarded
  // by count > POP_MIN so the tank never empties.
  if (count > POP_MIN) {
    let best: { pred: EntityRuntime; prey: EntityRuntime; adv: number } | null = null;
    for (const pred of rts) {
      if (pred.emigrating || now < pred.postMealUntil) continue;
      for (const prey of rts) {
        if (prey.id === pred.id || prey.emigrating) continue;
        if (pred.currentSize < prey.currentSize * PREDATION_SIZE_RATIO) continue;
        if (dist(pred, prey) > PREDATION_OVERLAP) continue;
        const adv = pred.currentSize / prey.currentSize;
        if (!best || adv > best.adv) best = { pred, prey, adv };
      }
    }
    if (best) {
      candidates.push({
        event: { type: 'predation', predator: best.pred.id, prey: best.prey.id },
        weight: deathBias
      });
    }
  }

  // Emigration: a restless wanderer leaves for good.
  if (count > POP_MIN) {
    const eligible = rts.filter(
      (r) => !r.emigrating && r.genotype.wanderlust >= EMIGRATION_WANDERLUST_MIN
    );
    if (eligible.length > 0) {
      // Most restless leaves.
      const fish = eligible.reduce((m, r) =>
        r.genotype.wanderlust > m.genotype.wanderlust ? r : m
      );
      candidates.push({
        event: { type: 'emigration', fish: fish.id },
        weight: EMIGRATION_BASE_WEIGHT * deathBias
      });
    }
  }

  if (candidates.length === 0) return { type: 'none' };

  // Weighted pick.
  const total = candidates.reduce((s, c) => s + c.weight, 0);
  let r = rng() * total;
  for (const c of candidates) {
    if ((r -= c.weight) <= 0) return c.event;
  }
  return candidates[candidates.length - 1].event;
}
