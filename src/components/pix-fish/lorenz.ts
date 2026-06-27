// Lorenz-attractor morph engine for the pix fish.
//
// The fish should feel alive -- its outline slowly warps and its size gently
// breathes, wandering chaotically and never repeating. A sine/noise wobble
// would visibly loop and feel mechanical; the Lorenz system gives
// bounded-but-nonperiodic state, so the morph never repeats. That is the whole
// point of driving the shape and size from it.
//
// This module owns the math and the pure mapping from attractor state to render
// outputs. The aesthetic tunables (speed, smoothing, scale band, squash, skew,
// warp) are NOT constants here -- they come from a FishMorphConfig, edited at
// /admin/fish (see src/lib/fish/config.ts). The brain hook advances the
// attractor once per frame inside the existing rAF loop, smooths it, and writes
// deriveMorph()'s outputs to the DOM via refs; no second rAF, no per-frame
// React re-render.

import type { FishMorphConfig } from '@/lib/fish/config';

// ---------------------------------------------------------------------------
// Fixed constants -- these define the attractor and its normalization, not the
// look, so they are not exposed as tunables.
// ---------------------------------------------------------------------------

// Classic chaotic regime.
const SIGMA = 10;
const RHO = 28;
const BETA = 8 / 3;

// The SVG warp filter id. There is exactly one mascot mounted globally, so a
// constant id is safe.
export const WARP_FILTER_ID = 'pix-fish-warp';

// Normalization ranges. The classic regime keeps z roughly in [Z_MIN, Z_MAX]
// and x,y within +/- XY_RANGE. Outputs are clamped so an occasional excursion
// can never push the morph past its band.
const Z_MIN = 5;
const Z_MAX = 45;
const XY_RANGE = 20;

// The orbital excursion |x| swings ~once per orbit between roughly these bounds
// (the trajectory spirals around a lobe centered near |x| ~ 8.5). Mapping the
// outline deformation through this band sweeps it nearly full-range every orbit,
// lobe-independent, on a rhythm distinct from the z-driven size breath.
const X_ABS_MIN = 2;
const X_ABS_MAX = 14;

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

export interface LorenzState {
  x: number;
  y: number;
  z: number;
}

// Seed a point already on the attractor so there is no startup transient and the
// initial size lands mid-band (no first-frame pop).
export function seedLorenz(): LorenzState {
  return { x: -6, y: -6, z: 24 };
}

function derivatives(s: LorenzState): LorenzState {
  return {
    x: SIGMA * (s.y - s.x),
    y: s.x * (RHO - s.z) - s.y,
    z: s.x * s.y - BETA * s.z
  };
}

// One classic RK4 step. Stable at the small steps we use here.
export function lorenzStep(s: LorenzState, h: number): LorenzState {
  const k1 = derivatives(s);
  const k2 = derivatives({ x: s.x + (h / 2) * k1.x, y: s.y + (h / 2) * k1.y, z: s.z + (h / 2) * k1.z });
  const k3 = derivatives({ x: s.x + (h / 2) * k2.x, y: s.y + (h / 2) * k2.y, z: s.z + (h / 2) * k2.z });
  const k4 = derivatives({ x: s.x + h * k3.x, y: s.y + h * k3.y, z: s.z + h * k3.z });
  return {
    x: s.x + (h / 6) * (k1.x + 2 * k2.x + 2 * k3.x + k4.x),
    y: s.y + (h / 6) * (k1.y + 2 * k2.y + 2 * k3.y + k4.y),
    z: s.z + (h / 6) * (k1.z + 2 * k2.z + 2 * k3.z + k4.z)
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// Map a value in [lo, hi] to [0, 1], clamped.
function norm01(v: number, lo: number, hi: number): number {
  return clamp((v - lo) / (hi - lo), 0, 1);
}

// Map a value in [-range, range] to [-1, 1], clamped.
function norm11(v: number, range: number): number {
  return clamp(v / range, -1, 1);
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

export interface MorphOutputs {
  // Non-uniform scale (uniform size band folded in), for the inner <g>.
  scaleX: number;
  scaleY: number;
  // Lean, in degrees, for the inner <g>.
  skewDeg: number;
  // feDisplacementMap scale.
  warp: number;
  // Drives the existing body-path variant interpolation, in [0, variants).
  morphProgress: number;
}

// Pure mapping from the (already smoothed) attractor state to render outputs,
// using the live config. Size rides z; the outline deformation (variant
// morphProgress + warp) rides the orbital excursion |x|, which swings nearly
// full-range every orbit on a rhythm independent of the z size breath -- so the
// silhouette visibly morphs even while the size is steady. Squash/skew add
// signed asymmetry from x/y.
export function deriveMorph(
  smoothed: LorenzState,
  variants: number,
  cfg: FishMorphConfig
): MorphOutputs {
  const size = lerp(cfg.scaleMin, cfg.scaleMax, norm01(smoothed.z, Z_MIN, Z_MAX));
  const a = norm11(smoothed.x, XY_RANGE);
  const shape = norm01(Math.abs(smoothed.x), X_ABS_MIN, X_ABS_MAX);
  return {
    scaleX: size * (1 + cfg.squashAmount * a),
    scaleY: size * (1 - cfg.squashAmount * a),
    skewDeg: cfg.skewAmount * norm11(smoothed.y, XY_RANGE),
    warp: lerp(0, cfg.warpAmount, shape),
    // Keep strictly below `variants`: buildBodyPath wraps via `% n`, so exactly
    // `variants` would snap to variant 0 instead of blending from the last one.
    morphProgress: Math.min(shape * variants, variants - 1e-3)
  };
}

// The center of the fish viewBox ("0 0 110 65"). The morph transform is baked
// around this point rather than relying on transform-box:fill-box, because the
// inner <g> content bounding box (eye/mouth sit far to the left) is not centered.
export const MORPH_ORIGIN_X = 55;
export const MORPH_ORIGIN_Y = 32.5;

// Build the inner-<g> transform string for the given outputs.
export function morphTransform(out: MorphOutputs): string {
  return (
    `translate(${MORPH_ORIGIN_X}px, ${MORPH_ORIGIN_Y}px) ` +
    `scale(${out.scaleX.toFixed(4)}, ${out.scaleY.toFixed(4)}) ` +
    `skewX(${out.skewDeg.toFixed(3)}deg) ` +
    `translate(${-MORPH_ORIGIN_X}px, ${-MORPH_ORIGIN_Y}px)`
  );
}
