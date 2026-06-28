// The two faces of a fish.
//
// EntityView is the React-facing record that drives the keyed list: it changes
// ONLY on discrete life events (membership + phase). EntityRuntime is the
// sim-internal physics/morph state, held in a ref Map and mutated every frame by
// the single rAF loop -- it never lives in React state, so motion/morph never
// triggers a re-render.

import type { BoidsWeights, FishGenotype } from './genotype';
import type { FishFeature } from './feature';
import type { LorenzState } from './lorenz';

// The preserved per-fish behavior states. `wandering` is the dominant state and
// is where boids social steering runs; the others keep their old target-seek
// with boids suppressed. `emigrating` is a runtime flag, not a behavior, because
// a fish can be told to leave from any state.
export type Behavior =
  | 'wandering'
  | 'napping'
  | 'glancing'
  | 'perched'
  | 'hiding'
  | 'excursion'
  | 'startled';

export type ExitKind = 'chomp' | 'emigrate' | 'natural';

export interface EntityView {
  id: number;
  seed: number;
  genotype: FishGenotype;
  feature: FishFeature;
  phase: 'entering' | 'alive' | 'exiting';
  exitKind?: ExitKind;
}

export interface EntityRefs {
  container: HTMLDivElement | null;
  facing: HTMLDivElement | null;
  morphGroup: SVGGElement | null;
  warp: SVGFEDisplacementMapElement | null;
  body: SVGPathElement | null;
  eye: SVGGElement | null;
  mouth: SVGPathElement | null;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface EntityRuntime {
  id: number;
  genotype: FishGenotype;

  // Lorenz morph state (per fish, reusing the kernel).
  lorenz: LorenzState;
  lorenzSmooth: LorenzState;

  // Motion.
  pos: Vec2;
  vel: Vec2;
  target: Vec2;
  facing: 1 | -1;
  speed: number; // current cruising speed for special-state seeks

  // Live boids weights (drift slowly around the genotype values).
  boids: BoidsWeights;

  // Sizing. baseSize grows with predation; currentSize = baseSize * breath, set
  // each frame and read by predation checks.
  baseSize: number;
  currentSize: number;

  // Lifecycle bookkeeping.
  bornAt: number;
  reproCooldownUntil: number;
  postMealUntil: number;
  emigrating: boolean;

  // Behavior machine (preserved from the single-fish brain).
  behavior: Behavior;
  behaviorEndsAt: number;
  nextBlinkAt: number;
  blinkPhase: 'open' | 'closing' | 'closed';
  zRestore: string;

  // Throttle marker for the imperative body-path `d` write.
  lastPathAt: number;

  refs: EntityRefs;
}

export function emptyRefs(): EntityRefs {
  return {
    container: null,
    facing: null,
    morphGroup: null,
    warp: null,
    body: null,
    eye: null,
    mouth: null
  };
}
