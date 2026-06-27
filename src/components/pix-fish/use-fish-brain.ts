'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { pickHideTarget, pickPerchTarget } from './dom-targets';
import { NUM_FISH_VARIANTS } from './fish-sprite';
import type { EyeState, MouthState } from './fish-sprite';
import {
  deriveMorph,
  LORENZ_SPEED,
  lorenzStep,
  morphTransform,
  seedLorenz,
  SMOOTHING,
  WARP_AMOUNT,
  type LorenzState
} from './lorenz';

// The brain. A single requestAnimationFrame loop drives a probabilistic
// state machine. Position, velocity, and time are kept in refs so the RAF
// path does not retrigger React; only behavior, eye, mouth, and facing
// changes (a handful per minute) cause rerenders.
//
// Coordinate system: position is the fish's top-left corner in fixed
// viewport coordinates. The parent container is fixed-positioned at (0,0)
// and gets `transform: translate3d(x, y, 0)` written to its style each
// frame. The sprite child keeps the facing flip in a CSS-transitioned
// `scaleX` so the turn is animated.

type Behavior =
  | 'wandering'
  | 'napping'
  | 'glancing'
  | 'perched'
  | 'hiding'
  | 'excursion'
  | 'startled';

interface FishBrainState {
  behavior: Behavior;
  eyeState: EyeState;
  mouthState: MouthState;
  facing: 1 | -1;
  morphProgress: number;
}

const SPRITE_W = 72;
const SPRITE_H = 43;
const MIN_SPEED = 30;
const MAX_SPEED = 80;
const STARTLE_SPEED = 240;

// Behavior dwell ranges in milliseconds. Picked randomly within the range
// each time the state is entered.
const DWELL: Record<Behavior, [number, number]> = {
  wandering: [5000, 15000],
  napping: [8000, 30000],
  glancing: [800, 2200],
  perched: [5000, 20000],
  hiding: [3000, 10000],
  excursion: [5000, 12000],
  startled: [600, 600]
};

// Transition weights out of each behavior. Wandering is the strong
// attractor; the rarer states have lower weights so they feel like
// occasional accents, not constant churn.
const TRANSITIONS: Record<Behavior, Array<[Behavior, number]>> = {
  wandering: [
    ['wandering', 50],
    ['napping', 15],
    ['glancing', 8],
    ['perched', 10],
    ['hiding', 8],
    ['excursion', 9]
  ],
  napping: [
    ['wandering', 75],
    ['napping', 25]
  ],
  glancing: [
    ['wandering', 100]
  ],
  perched: [
    ['wandering', 85],
    ['napping', 15]
  ],
  hiding: [
    ['wandering', 100]
  ],
  excursion: [
    ['wandering', 100]
  ],
  startled: [
    ['wandering', 100]
  ]
};

function pickWeighted<T>(weights: Array<[T, number]>): T {
  const total = weights.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [v, w] of weights) {
    if ((r -= w) <= 0) return v;
  }
  return weights[0][0];
}

function randInRange([a, b]: [number, number]): number {
  return a + Math.random() * (b - a);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

interface BrainOptions {
  paused: boolean;
}

interface BrainAPI {
  state: FishBrainState;
  setContainerRef: (el: HTMLDivElement | null) => void;
  setMorphGroupRef: (el: SVGGElement | null) => void;
  setWarpRef: (el: SVGFEDisplacementMapElement | null) => void;
  startle: (clickX: number, clickY: number) => void;
}

export function useFishBrain({ paused }: BrainOptions): BrainAPI {
  const [state, setState] = useState<FishBrainState>({
    behavior: 'wandering',
    eyeState: 'open',
    mouthState: 'smile',
    facing: -1,
    morphProgress: 0
  });

  const containerRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  // reducedMotion lives in React state, not a ref, so a mid-session toggle of
  // prefers-reduced-motion can re-key the RAF effect and switch the fish into
  // (or out of) the parked branch immediately. A ref alone would not.
  const [reducedMotion, setReducedMotion] = useState(false);
  const reducedMotionRef = useRef(false);
  reducedMotionRef.current = reducedMotion;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const posRef = useRef({ x: 80, y: 80 });
  const targetRef = useRef({ x: 80, y: 80 });
  const velRef = useRef({ x: 0, y: 0 });
  const speedRef = useRef(50);
  const behaviorEndsAtRef = useRef(0);
  const nextBlinkAtRef = useRef(0);
  const blinkPhaseRef = useRef<'open' | 'closing' | 'closed'>('open');
  const lastFrameRef = useRef(0);
  const cursorRef = useRef({ x: -1, y: -1, lastMoveAt: 0 });
  const zRestoreRef = useRef<string>('');
  // morphProgress advances as a float in the RAF loop; setState is throttled
  // to ~16fps so React doesn't rerender every frame.
  const morphProgressRef = useRef(0);
  const lastMorphUpdateRef = useRef(0);

  // Lorenz attractor driving shape + size. The raw state is integrated each
  // frame; lorenzSmoothRef is its per-dimension EMA so every mapped output
  // transitions silkily. The two SVG nodes are mutated imperatively (no
  // re-render): the inner <g> gets the scale/squash/skew transform, and the
  // feDisplacementMap gets the warp `scale`.
  const lorenzRef = useRef<LorenzState>(seedLorenz());
  const lorenzSmoothRef = useRef<LorenzState>(seedLorenz());
  const morphGroupRef = useRef<SVGGElement | null>(null);
  const warpRef = useRef<SVGFEDisplacementMapElement | null>(null);

  // resetMorph -- pin the morph at neutral (scale 1, no warp). Used for
  // prefers-reduced-motion and to seed nodes the moment they attach.
  const resetMorph = useCallback(() => {
    if (morphGroupRef.current) morphGroupRef.current.style.transform = '';
    if (warpRef.current) warpRef.current.setAttribute('scale', '0');
  }, []);

  // commitTransform -- writes position + facing-driven z-index hints to the
  // DOM without rerendering React.
  const commitTransform = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const { x, y } = posRef.current;
    el.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)`;
  }, []);

  // pickWanderTarget -- random point inside the viewport with margin so the
  // fish doesn't snap against the edges.
  const pickWanderTarget = useCallback(() => {
    const margin = 24;
    return {
      x: margin + Math.random() * Math.max(window.innerWidth - SPRITE_W - margin * 2, 1),
      y: margin + Math.random() * Math.max(window.innerHeight - SPRITE_H - margin * 2, 1)
    };
  }, []);

  // pickExcursionTarget -- a point comfortably outside the viewport so the
  // fish exits, lingers, then comes back when the state ends.
  const pickExcursionTarget = useCallback(() => {
    const side = Math.floor(Math.random() * 4);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    switch (side) {
      case 0:
        return { x: -SPRITE_W - 60, y: Math.random() * vh };
      case 1:
        return { x: vw + 60, y: Math.random() * vh };
      case 2:
        return { x: Math.random() * vw, y: -SPRITE_H - 60 };
      default:
        return { x: Math.random() * vw, y: vh + 60 };
    }
  }, []);

  // enterBehavior -- side effects for entering each state: choose dwell,
  // mouth/eye visuals, z-index, target. Caller passes the next behavior; we
  // also call setState so the React tree picks up the new visuals.
  const enterBehavior = useCallback(
    (next: Behavior, now: number) => {
      const el = containerRef.current;
      const prev = stateRef.current.behavior;
      const dwell = randInRange(DWELL[next]);
      behaviorEndsAtRef.current = now + dwell;

      let mouthState: MouthState = 'smile';
      let eyeState: EyeState = stateRef.current.eyeState;

      if (next === 'wandering') {
        targetRef.current = pickWanderTarget();
        speedRef.current = randInRange([MIN_SPEED, MAX_SPEED]);
        if (el) el.style.zIndex = '30';
      } else if (next === 'napping') {
        // Copy, don't alias. The bob formula writes pos.y = target.y + bob
        // each frame; aliasing posRef would mutate the anchor too, causing
        // the fish to drift downward across longer naps.
        targetRef.current = { ...posRef.current };
        speedRef.current = 0;
        mouthState = 'flat';
        eyeState = 'closed';
        blinkPhaseRef.current = 'closed';
        if (el) el.style.zIndex = '30';
      } else if (next === 'glancing') {
        // Don't change target; glancing just biases facing toward the
        // cursor for a moment, then resumes wandering on exit.
      } else if (next === 'perched') {
        const t = pickPerchTarget();
        if (!t) return enterBehavior('wandering', now);
        targetRef.current = t;
        speedRef.current = randInRange([60, 100]);
        if (el) el.style.zIndex = '40';
      } else if (next === 'hiding') {
        const t = pickHideTarget();
        if (!t) return enterBehavior('wandering', now);
        targetRef.current = t;
        speedRef.current = randInRange([40, 70]);
        if (el) {
          zRestoreRef.current = el.style.zIndex || '30';
          // z-index:1 is below z-30 (normal fish layer) but still above
          // static-flow content unless the cards establish their own
          // stacking context. pointer-events:none ensures the fish never
          // intercepts clicks on whatever it overlaps while "hiding".
          el.style.zIndex = '1';
          el.style.pointerEvents = 'none';
        }
      } else if (next === 'excursion') {
        targetRef.current = pickExcursionTarget();
        speedRef.current = randInRange([60, 100]);
        if (el) el.style.zIndex = '30';
      } else if (next === 'startled') {
        mouthState = 'o';
        speedRef.current = STARTLE_SPEED;
      }

      // Restore z + pointer-events when leaving hiding.
      if (prev === 'hiding' && next !== 'hiding' && el) {
        el.style.zIndex = zRestoreRef.current || '30';
        el.style.pointerEvents = '';
      }

      setState((s) => ({ ...s, behavior: next, mouthState, eyeState }));
    },
    [pickWanderTarget, pickExcursionTarget]
  );

  // tick -- the RAF body.
  const tick = useCallback(
    (now: number) => {
      const dt = lastFrameRef.current ? (now - lastFrameRef.current) / 1000 : 1 / 60;
      lastFrameRef.current = now;

      const cur = stateRef.current.behavior;
      const pos = posRef.current;
      const target = targetRef.current;
      const speed = speedRef.current;

      // Move toward target (skip for napping).
      if (cur !== 'napping') {
        const dx = target.x - pos.x;
        const dy = target.y - pos.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 0.5) {
          const step = Math.min(speed * dt, dist);
          const nx = (dx / dist) * step;
          const ny = (dy / dist) * step;
          pos.x += nx;
          pos.y += ny;
          velRef.current = { x: nx / dt, y: ny / dt };

          // Hysteresis on facing flip: only flip when |vx| is meaningful, so
          // a fish heading straight up/down doesn't twitch direction.
          if (Math.abs(velRef.current.x) > 8) {
            const wantFacing: 1 | -1 = velRef.current.x < 0 ? -1 : 1;
            if (wantFacing !== stateRef.current.facing) {
              setState((s) => ({ ...s, facing: wantFacing }));
            }
          }
        } else if (cur === 'wandering') {
          // Reached target; pick a fresh nearby target so wandering feels
          // continuous rather than chunky.
          targetRef.current = pickWanderTarget();
        }
      } else {
        // Gentle bob while napping.
        const bob = Math.sin(now / 700) * 1.5;
        pos.y = target.y + bob;
      }

      // Perched: track the perch's top edge each frame so scrolling
      // doesn't strand the fish in mid-air.
      if (cur === 'perched') {
        const t = pickPerchTarget();
        // Don't repick on every frame; just nudge toward something current.
        // (pickPerchTarget is cheap but stochastic; we re-anchor only when
        // the current target has scrolled out.)
        if (t && (target.y < -SPRITE_H || target.y > window.innerHeight + SPRITE_H)) {
          targetRef.current = t;
        }
      }

      // Glancing: face the cursor for the duration.
      if (cur === 'glancing' && cursorRef.current.x >= 0) {
        const wantFacing: 1 | -1 = cursorRef.current.x < pos.x ? -1 : 1;
        if (wantFacing !== stateRef.current.facing) {
          setState((s) => ({ ...s, facing: wantFacing }));
        }
      }

      // Eye blink loop -- only when eye is in a state that can blink.
      // Napping holds eye closed; startled holds eye open.
      if (cur !== 'napping' && cur !== 'startled') {
        if (now >= nextBlinkAtRef.current) {
          const phase = blinkPhaseRef.current;
          if (phase === 'open') {
            blinkPhaseRef.current = 'closing';
            nextBlinkAtRef.current = now + 80;
            setState((s) => (s.eyeState === 'half' ? s : { ...s, eyeState: 'half' }));
          } else if (phase === 'closing') {
            blinkPhaseRef.current = 'closed';
            nextBlinkAtRef.current = now + 90;
            setState((s) => (s.eyeState === 'closed' ? s : { ...s, eyeState: 'closed' }));
          } else {
            blinkPhaseRef.current = 'open';
            nextBlinkAtRef.current = now + 4000 + Math.random() * 3000;
            setState((s) => (s.eyeState === 'open' ? s : { ...s, eyeState: 'open' }));
          }
        }
      }

      // Clamp position only for in-viewport behaviors; excursion is allowed
      // to roam outside.
      if (cur !== 'excursion') {
        pos.x = clamp(pos.x, -SPRITE_W * 0.5, window.innerWidth - SPRITE_W * 0.5);
        pos.y = clamp(pos.y, -SPRITE_H * 0.5, window.innerHeight - SPRITE_H * 0.5);
      }

      commitTransform();

      // Advance the Lorenz attractor and drive the fish's shape + size from it.
      // The step is scaled by the real frame dt (normalized to 60fps and
      // clamped) so the morph runs at the same pace on high-refresh displays and
      // RK4 stays stable after a background-tab dt spike.
      const frameScale = clamp(dt / (1 / 60), 0.25, 4);
      const raw = lorenzStep(lorenzRef.current, LORENZ_SPEED * frameScale);
      lorenzRef.current = raw;
      // Time-based EMA: SMOOTHING is the alpha per 60fps frame; scaling it by the
      // same frameScale keeps the effective smoothing time-constant identical
      // across refresh rates (a 120Hz display would otherwise smooth less).
      const alpha = 1 - Math.pow(1 - SMOOTHING, frameScale);
      const sm = lorenzSmoothRef.current;
      sm.x += alpha * (raw.x - sm.x);
      sm.y += alpha * (raw.y - sm.y);
      sm.z += alpha * (raw.z - sm.z);

      const morph = deriveMorph(sm, NUM_FISH_VARIANTS);
      if (morphGroupRef.current) {
        morphGroupRef.current.style.transform = morphTransform(morph);
      }
      if (WARP_AMOUNT > 0 && warpRef.current) {
        warpRef.current.setAttribute('scale', morph.warp.toFixed(3));
      }

      // The base body-path variant is now driven by the attractor too, so even
      // the outline never cycles. Only its source changed -- the React state
      // push stays throttled to ~16fps (the one pre-existing re-render path).
      morphProgressRef.current = morph.morphProgress;
      if (now - lastMorphUpdateRef.current >= 60) {
        lastMorphUpdateRef.current = now;
        const mp = morphProgressRef.current;
        setState((s) => (Math.abs(s.morphProgress - mp) < 0.001 ? s : { ...s, morphProgress: mp }));
      }

      // Behavior expiry -> sample next.
      if (now >= behaviorEndsAtRef.current) {
        const next = pickWeighted(TRANSITIONS[cur]);
        enterBehavior(next, now);
      }
    },
    [commitTransform, enterBehavior, pickWanderTarget]
  );

  // RAF lifecycle. Re-runs when paused or reducedMotion changes, so a
  // mid-session reduced-motion toggle immediately switches into (or out of)
  // the parked branch.
  useEffect(() => {
    if (paused) return;

    if (reducedMotion) {
      // Park the fish in a corner, no RAF. Eyes still blink on a long
      // timer so the mascot doesn't look frozen -- per the spec the
      // reduced-motion fish "parks in a corner and just blinks."
      const el = containerRef.current;
      const x = window.innerWidth - SPRITE_W - 24;
      const y = window.innerHeight - SPRITE_H - 48;
      posRef.current = { x, y };
      targetRef.current = { x, y };
      if (el) {
        el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        el.style.zIndex = '30';
      }
      // Freeze the morph at neutral -- scale 1, no warp -- per prefers-reduced-
      // motion. The rAF never starts in this branch, so the attractor never
      // advances; this also pins it if reduced-motion is toggled on mid-session.
      resetMorph();
      setState((s) => ({ ...s, behavior: 'napping', mouthState: 'flat', eyeState: 'open' }));

      // Blink cadence: ~every 5-8s, three-phase (open -> half -> closed -> open).
      // Driven by setTimeout rather than RAF to keep CPU at zero between blinks.
      let timer: ReturnType<typeof setTimeout> | null = null;
      const scheduleNext = () => {
        const wait = 5000 + Math.random() * 3000;
        timer = setTimeout(() => {
          setState((s) => (s.eyeState === 'half' ? s : { ...s, eyeState: 'half' }));
          timer = setTimeout(() => {
            setState((s) => (s.eyeState === 'closed' ? s : { ...s, eyeState: 'closed' }));
            timer = setTimeout(() => {
              setState((s) => (s.eyeState === 'open' ? s : { ...s, eyeState: 'open' }));
              scheduleNext();
            }, 120);
          }, 90);
        }, wait);
      };
      scheduleNext();
      return () => {
        if (timer) clearTimeout(timer);
      };
    }

    let raf = 0;
    const loop = (t: number) => {
      tick(t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame((t) => {
      lastFrameRef.current = t;
      behaviorEndsAtRef.current = t + 4000;
      nextBlinkAtRef.current = t + 2000 + Math.random() * 3000;
      // Seed an initial wandering target.
      targetRef.current = pickWanderTarget();
      loop(t);
    });

    return () => cancelAnimationFrame(raf);
  }, [paused, reducedMotion, tick, pickWanderTarget, resetMorph]);

  // Cursor tracking + reduced-motion change listener. The MQL listener
  // writes to React state (not just the ref) so the RAF effect re-keys and
  // immediately switches into / out of the parked branch -- no remount or
  // refresh required.
  useEffect(() => {
    if (paused) return;
    const onMove = (e: PointerEvent) => {
      cursorRef.current = { x: e.clientX, y: e.clientY, lastMoveAt: performance.now() };
    };
    window.addEventListener('pointermove', onMove, { passive: true });

    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    // Seed the current preference on (re)mount in addition to listening for
    // changes, so the first render after mount already reflects reality.
    setReducedMotion(mql.matches);
    const onMqlChange = () => setReducedMotion(mql.matches);
    mql.addEventListener('change', onMqlChange);

    const onResize = () => {
      const pos = posRef.current;
      pos.x = clamp(pos.x, 0, window.innerWidth - SPRITE_W);
      pos.y = clamp(pos.y, 0, window.innerHeight - SPRITE_H);
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('pointermove', onMove);
      mql.removeEventListener('change', onMqlChange);
      window.removeEventListener('resize', onResize);
    };
  }, [paused]);

  const startle = useCallback(
    (clickX: number, clickY: number) => {
      if (pausedRef.current || reducedMotionRef.current) return;
      const pos = posRef.current;
      const dx = pos.x - clickX;
      const dy = pos.y - clickY;
      const dist = Math.max(Math.hypot(dx, dy), 1);
      // Dart 180px away from the click point.
      targetRef.current = {
        x: pos.x + (dx / dist) * 180,
        y: pos.y + (dy / dist) * 180
      };
      enterBehavior('startled', performance.now());
    },
    [enterBehavior]
  );

  const setContainerRef = useCallback((el: HTMLDivElement | null) => {
    containerRef.current = el;
    if (el) {
      el.style.transform = `translate3d(${posRef.current.x}px, ${posRef.current.y}px, 0)`;
      el.style.zIndex = '30';
    }
  }, []);

  // Seed the morph nodes to neutral the moment they attach so there's no
  // first-frame flash before the rAF loop takes over (and so they're neutral
  // under prefers-reduced-motion, where the loop never runs).
  const setMorphGroupRef = useCallback(
    (el: SVGGElement | null) => {
      morphGroupRef.current = el;
      if (el) el.style.transform = '';
    },
    []
  );

  const setWarpRef = useCallback((el: SVGFEDisplacementMapElement | null) => {
    warpRef.current = el;
    if (el) el.setAttribute('scale', '0');
  }, []);

  return { state, setContainerRef, setMorphGroupRef, setWarpRef, startle };
}
