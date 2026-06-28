// Pure drift math. No DB, no Date -- deterministic and testable.
//
// A "drift" is a steerable walk through caption-embedding space: you fall from
// one image to the next by pure semantic nearness, and you bend the fall as you
// go. The server is stateless -- the client replays its whole trajectory each
// step (visited ids + steer picks), the server reconstructs the heading and the
// next point to search near, then snaps to the nearest unseen real image.
//
// This is the continuous, steerable cousin of the taste vector: instead of one
// centroid that re-ranks the gallery once, a moving point that carves a path.

import { meanVector, normalize } from '@/lib/taste/vector';

export type SteerDir = 'toward' | 'away';

// How strongly the direction of recent travel carries the drift forward when
// you are NOT steering -- this is what makes it keep *falling* on its own.
const MOMENTUM_WEIGHT = 0.5;
// How strongly accumulated steer (toward/away picks) displaces the position.
// Deliberately > 1 so an explicit push-away can OVERCOME the current position:
// away-ing the current frame makes bias = -position, and target = position +
// BIAS_REACH * (-position) = position * (1 - BIAS_REACH); with BIAS_REACH > 1
// that flips past the origin to the opposite direction. (At <= 1 the step would
// just rescale `position` and the rejection control would do nothing until
// momentum existed.) The bias is applied OUTSIDE the lucidity reach so steering
// always bites, even at low lucidity.
const BIAS_REACH = 1.3;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// Lucidity 0..1 -> step size: how far each frame reaches past the current
// position before snapping to the nearest real image. Low = small reach =
// adjacent images = a seamless morph; high = long reach = surreal leaps across
// meaning. The floor keeps even lucid play advancing; the ceiling keeps the
// wildest leaps from flinging the heading completely off the manifold.
export function stepSize(lucidity: number): number {
  return 0.12 + clamp01(lucidity) * 0.78; // 0.12 (dreamlike) .. 0.9 (lurching)
}

// Compute the next target POINT in embedding space to search near.
//   position  -- vector of the current (last visited) image
//   previous  -- vector of the image before it (for momentum), or null
//   toward    -- vectors of images the visitor pulled the drift toward
//   away      -- vectors of images the visitor pushed the drift away from
//   lucidity  -- 0..1, how big a leap to take this step
// Returns a unit vector for searchByVector, or null if the result is degenerate
// (all-zero / non-finite) -- the caller should fall back to a random seed then.
export function driftTarget(
  position: number[],
  previous: number[] | null,
  toward: number[][],
  away: number[][],
  lucidity: number
): number[] | null {
  if (!Array.isArray(position) || position.length === 0) return null;
  const dim = position.length;

  // bias = mean(toward) - mean(away): the accumulated steer direction. Built
  // from unit vectors so its magnitude stays ~1 and dominates when you steer.
  const mt = meanVector(toward);
  const ma = meanVector(away);
  const bias = new Array<number>(dim).fill(0);
  if (mt && mt.length === dim) for (let i = 0; i < dim; i++) bias[i]! += mt[i]!;
  if (ma && ma.length === dim) for (let i = 0; i < dim; i++) bias[i]! -= ma[i]!;

  // momentum = position - previous: the direction we are already travelling, so
  // the fall continues even with no input.
  const mom = new Array<number>(dim).fill(0);
  if (previous && previous.length === dim) {
    for (let i = 0; i < dim; i++) mom[i] = position[i]! - previous[i]!;
  }

  // Cold start (no steer, no momentum): aim at the current position itself so we
  // still advance to its nearest unseen neighbor instead of stalling.
  let drive = 0;
  for (let i = 0; i < dim; i++) drive += bias[i]! * bias[i]! + mom[i]! * mom[i]!;
  if (Math.sqrt(drive) < 1e-9) {
    const out0 = normalize(position);
    return out0.every((x) => Number.isFinite(x)) ? out0 : null;
  }

  // Step the position: momentum carries the fall (scaled by lucidity -> how far
  // each leap reaches), while the steer bias is applied at full BIAS_REACH so a
  // push-away can always overcome where you are (see BIAS_REACH above).
  const reach = stepSize(lucidity);
  const target = new Array<number>(dim);
  for (let i = 0; i < dim; i++) {
    target[i] = position[i]! + reach * MOMENTUM_WEIGHT * mom[i]! + BIAS_REACH * bias[i]!;
  }

  const out = normalize(target);
  if (!out.every((x) => Number.isFinite(x))) return null;
  if (out.every((x) => x === 0)) return null;
  return out;
}

// Clamp + sanitize the trajectory the client posts so a crafted body can't fan
// out unbounded work: cap the visited window (also the no-repeat window) and the
// steer sets, keep only positive integers, and bound lucidity to 0..1.
export const VISITED_WINDOW = 120;
export const STEER_WINDOW = 24;

export function sanitizeTrajectory(input: {
  visited?: unknown;
  toward?: unknown;
  away?: unknown;
  lucidity?: unknown;
}): { visited: number[]; toward: number[]; away: number[]; lucidity: number } {
  const ids = (v: unknown, cap: number): number[] =>
    (Array.isArray(v) ? v : [])
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(-cap);
  const lucidity = clamp01(Number(input.lucidity));
  return {
    visited: ids(input.visited, VISITED_WINDOW),
    toward: ids(input.toward, STEER_WINDOW),
    away: ids(input.away, STEER_WINDOW),
    lucidity: Number.isFinite(lucidity) ? lucidity : 0.35
  };
}
