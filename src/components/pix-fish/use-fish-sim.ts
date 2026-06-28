'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_FISH_MORPH_CONFIG, type FishMorphConfig } from '@/lib/fish/config';
import { computeSteering, vlen } from './boids';
import { pickHideTarget, pickPerchTarget } from './dom-targets';
import { emptyRefs, type Behavior, type EntityRefs, type EntityRuntime, type EntityView, type ExitKind, type Vec2 } from './entity';
import { selectEvent, type LifeEvent } from './events';
import { featureFromSeed } from './feature';
import { applyGenotypeToConfig, blendGenotype, mutateGenotype, randomGenotype, type FishGenotype } from './genotype';
import { buildBodyPath, EYE_CX, EYE_CY, MOUTH_PATHS, NUM_FISH_VARIANTS } from './fish-sprite';
import { deriveMorph, lorenzStep, morphTransform, seedLorenz, type MorphOutputs } from './lorenz';
import { randInt, randRange, simRng } from './prng';
import {
  COUPLING_STRENGTH,
  DEBUG_FAST_EVENTS,
  EDGE_MARGIN,
  ENTER_MS,
  EVENT_INTERVAL_MAX,
  EVENT_INTERVAL_MAX_FAST,
  EVENT_INTERVAL_MIN,
  EVENT_INTERVAL_MIN_FAST,
  EVENT_RETRY_MAX,
  EVENT_RETRY_MAX_FAST,
  EVENT_RETRY_MIN,
  EVENT_RETRY_MIN_FAST,
  EXIT_MS,
  INITIAL_POP,
  MAX_SPEED,
  MIN_SPEED,
  NEIGHBOR_K,
  NEIGHBOR_RADIUS,
  OFFPAGE_MARGIN,
  POP_MAX,
  POST_MEAL_COOLDOWN,
  POST_MEAL_COOLDOWN_FAST,
  PREDATION_GROWTH,
  PREDATION_MAX_BASESIZE,
  REPRO_COOLDOWN,
  REPRO_COOLDOWN_FAST,
  SCATTER_RADIUS,
  SCATTER_SPEED,
  SPRITE_H,
  SPRITE_W,
  WANDER_RETARGET_DIST
} from './sim-config';

// The single simulation. One requestAnimationFrame loop drives EVERY fish:
// per-fish Lorenz morph/size (with weak neighbor coupling), boids social
// steering during wandering, the preserved per-fish behavior machine
// (nap/perch/hide/glance/excursion/startled) for the special states, and the
// discrete life-event clock (birth / predation / emigration / immigration).
//
// Motion + morph are written to the DOM imperatively via refs held in a Map; the
// React `entities` list changes ONLY on life events, so no per-frame re-renders.

// Behavior dwell ranges (ms), ported from the single-fish brain.
const DWELL: Record<Behavior, [number, number]> = {
  wandering: [6000, 16000],
  napping: [8000, 26000],
  glancing: [800, 2200],
  perched: [5000, 18000],
  hiding: [3000, 9000],
  excursion: [5000, 11000],
  startled: [600, 600]
};

// Transition weights, ported. Wandering is the strong attractor so social
// steering is what you mostly see; the others are occasional accents.
const TRANSITIONS: Record<Behavior, Array<[Behavior, number]>> = {
  wandering: [
    ['wandering', 58],
    ['napping', 12],
    ['glancing', 8],
    ['perched', 8],
    ['hiding', 6],
    ['excursion', 5]
  ],
  napping: [['wandering', 80], ['napping', 20]],
  glancing: [['wandering', 100]],
  perched: [['wandering', 85], ['napping', 15]],
  hiding: [['wandering', 100]],
  excursion: [['wandering', 100]],
  startled: [['wandering', 100]]
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function randInRange([a, b]: [number, number]): number {
  return a + simRng() * (b - a);
}

function pickWeighted<T>(weights: Array<[T, number]>): T {
  const total = weights.reduce((s, [, w]) => s + w, 0);
  let r = simRng() * total;
  for (const [v, w] of weights) {
    if ((r -= w) <= 0) return v;
  }
  return weights[0][0];
}

interface SimOptions {
  paused: boolean;
  config?: FishMorphConfig;
}

export interface SimDebug {
  population: number;
  lastEvent: string;
}

interface SimAPI {
  entities: EntityView[];
  register: (id: number, refs: EntityRefs) => void;
  unregister: (id: number) => void;
  scatter: (x: number, y: number) => void;
  debug: SimDebug;
}

export function useFishSim({ paused, config = DEFAULT_FISH_MORPH_CONFIG }: SimOptions): SimAPI {
  const [entities, setEntities] = useState<EntityView[]>([]);
  const [lastEvent, setLastEvent] = useState<string>('--');

  const runtimesRef = useRef<Map<number, EntityRuntime>>(new Map());
  const nextIdRef = useRef(1);
  const nextEventAtRef = useRef(0);
  const lastFrameRef = useRef(0);
  const pendingRemovalRef = useRef<Set<number>>(new Set());
  const timeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const seededRef = useRef(false);
  const cursorRef = useRef({ x: -1, y: -1 });

  const configRef = useRef(config);
  configRef.current = config;

  const [reducedMotion, setReducedMotion] = useState(false);
  const reducedMotionRef = useRef(false);
  reducedMotionRef.current = reducedMotion;

  // --- tunable selectors (fast-mode aware) ----------------------------------
  const eventInterval = useCallback(
    () =>
      DEBUG_FAST_EVENTS
        ? randRange(simRng, EVENT_INTERVAL_MIN_FAST, EVENT_INTERVAL_MAX_FAST)
        : randRange(simRng, EVENT_INTERVAL_MIN, EVENT_INTERVAL_MAX),
    []
  );
  const retryInterval = useCallback(
    () =>
      DEBUG_FAST_EVENTS
        ? randRange(simRng, EVENT_RETRY_MIN_FAST, EVENT_RETRY_MAX_FAST)
        : randRange(simRng, EVENT_RETRY_MIN, EVENT_RETRY_MAX),
    []
  );
  const reproCooldown = useCallback(
    () => (DEBUG_FAST_EVENTS ? REPRO_COOLDOWN_FAST : REPRO_COOLDOWN),
    []
  );
  const postMealCooldown = useCallback(
    () => (DEBUG_FAST_EVENTS ? POST_MEAL_COOLDOWN_FAST : POST_MEAL_COOLDOWN),
    []
  );

  // --- geometry helpers ------------------------------------------------------
  const bounds = useCallback(() => ({ w: window.innerWidth, h: window.innerHeight }), []);

  const pickWanderTarget = useCallback((): Vec2 => {
    const margin = 40;
    return {
      x: margin + simRng() * Math.max(window.innerWidth - SPRITE_W - margin * 2, 1),
      y: margin + simRng() * Math.max(window.innerHeight - SPRITE_H - margin * 2, 1)
    };
  }, []);

  const pickExcursionTarget = useCallback((): Vec2 => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    switch (Math.floor(simRng() * 4)) {
      case 0:
        return { x: -SPRITE_W - 60, y: simRng() * vh };
      case 1:
        return { x: vw + 60, y: simRng() * vh };
      case 2:
        return { x: simRng() * vw, y: -SPRITE_H - 60 };
      default:
        return { x: simRng() * vw, y: vh + 60 };
    }
  }, []);

  // Far off-page target for a permanent departure.
  const offPageTarget = useCallback((): Vec2 => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const m = OFFPAGE_MARGIN * 3;
    switch (Math.floor(simRng() * 4)) {
      case 0:
        return { x: -SPRITE_W - m, y: simRng() * vh };
      case 1:
        return { x: vw + m, y: simRng() * vh };
      case 2:
        return { x: simRng() * vw, y: -SPRITE_H - m };
      default:
        return { x: simRng() * vw, y: vh + m };
    }
  }, []);

  // Just-off-page spawn point for an arrival, with a target heading inward.
  const immigrantStart = useCallback((): { pos: Vec2; target: Vec2 } => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const target = pickWanderTarget();
    switch (Math.floor(simRng() * 4)) {
      case 0:
        return { pos: { x: -SPRITE_W - OFFPAGE_MARGIN, y: simRng() * vh }, target };
      case 1:
        return { pos: { x: vw + OFFPAGE_MARGIN, y: simRng() * vh }, target };
      case 2:
        return { pos: { x: simRng() * vw, y: -SPRITE_H - OFFPAGE_MARGIN }, target };
      default:
        return { pos: { x: simRng() * vw, y: vh + OFFPAGE_MARGIN }, target };
    }
  }, [pickWanderTarget]);

  // --- runtime + view creation ----------------------------------------------
  const makeRuntime = useCallback(
    (id: number, genotype: FishGenotype, pos: Vec2, opts?: { emigrating?: boolean; target?: Vec2 }): EntityRuntime => {
      const now = performance.now();
      return {
        id,
        genotype,
        lorenz: seedLorenz(),
        lorenzSmooth: seedLorenz(),
        pos: { ...pos },
        vel: { x: 0, y: 0 },
        target: opts?.target ? { ...opts.target } : { ...pos },
        facing: -1,
        speed: randRange(simRng, MIN_SPEED, MAX_SPEED),
        boids: { ...genotype.boids },
        baseSize: genotype.baseSize,
        currentSize: genotype.baseSize,
        bornAt: now,
        reproCooldownUntil: 0,
        postMealUntil: 0,
        emigrating: opts?.emigrating ?? false,
        behavior: 'wandering',
        behaviorEndsAt: now + randInRange(DWELL.wandering),
        nextBlinkAt: now + 1500 + simRng() * 3000,
        blinkPhase: 'open',
        zRestore: '30',
        lastPathAt: 0,
        refs: emptyRefs()
      };
    },
    []
  );

  // Spawn a fish: allocate a monotonic id (-> unique seed -> unique flourish by
  // construction), create its runtime, and return the React view to append.
  const spawn = useCallback(
    (genotype: FishGenotype, pos: Vec2, opts?: { emigrating?: boolean; target?: Vec2 }): EntityView => {
      const id = nextIdRef.current++;
      runtimesRef.current.set(id, makeRuntime(id, genotype, pos, opts));
      return { id, seed: id, genotype, feature: featureFromSeed(id), phase: 'entering' };
    },
    [makeRuntime]
  );

  const track = useCallback((t: ReturnType<typeof setTimeout>) => {
    timeoutsRef.current.add(t);
  }, []);

  const addEntities = useCallback(
    (views: EntityView[]) => {
      if (views.length === 0) return;
      setEntities((prev) => [...prev, ...views]);
      // Promote 'entering' -> 'alive' after the enter animation.
      const ids = new Set(views.map((v) => v.id));
      const t = setTimeout(() => {
        timeoutsRef.current.delete(t);
        setEntities((prev) =>
          prev.map((e) => (ids.has(e.id) && e.phase === 'entering' ? { ...e, phase: 'alive' } : e))
        );
      }, ENTER_MS);
      track(t);
    },
    [track]
  );

  const removeEntity = useCallback(
    (id: number, exitKind: ExitKind) => {
      if (pendingRemovalRef.current.has(id)) return;
      pendingRemovalRef.current.add(id);
      setEntities((prev) => prev.map((e) => (e.id === id ? { ...e, phase: 'exiting', exitKind } : e)));
      const t = setTimeout(() => {
        timeoutsRef.current.delete(t);
        runtimesRef.current.delete(id);
        pendingRemovalRef.current.delete(id);
        setEntities((prev) => prev.filter((e) => e.id !== id));
      }, EXIT_MS);
      track(t);
    },
    [track]
  );

  // --- imperative DOM writers -----------------------------------------------
  const setEye = useCallback((r: EntityRuntime, scaleY: number) => {
    const el = r.refs.eye;
    if (!el) return;
    el.setAttribute(
      'transform',
      scaleY >= 0.99 ? '' : `translate(${EYE_CX} ${EYE_CY}) scale(1 ${scaleY}) translate(${-EYE_CX} ${-EYE_CY})`
    );
  }, []);

  const setMouth = useCallback((r: EntityRuntime, kind: keyof typeof MOUTH_PATHS) => {
    if (r.refs.mouth) r.refs.mouth.setAttribute('d', MOUTH_PATHS[kind]);
  }, []);

  const applyFacing = useCallback((r: EntityRuntime) => {
    if (r.refs.facing) r.refs.facing.style.transform = `scaleX(${r.facing})`;
  }, []);

  const resetMorph = useCallback((r: EntityRuntime) => {
    if (r.refs.morphGroup) r.refs.morphGroup.removeAttribute('transform');
    if (r.refs.warp) r.refs.warp.setAttribute('scale', '0');
    if (r.refs.body) r.refs.body.setAttribute('d', buildBodyPath(0));
    r.currentSize = r.baseSize;
  }, []);

  // --- behavior machine ------------------------------------------------------
  const enterBehavior = useCallback(
    (r: EntityRuntime, next: Behavior, now: number) => {
      const prev = r.behavior;
      const el = r.refs.container;
      r.behaviorEndsAt = now + randInRange(DWELL[next]);

      if (next === 'wandering') {
        r.target = pickWanderTarget();
        r.speed = randRange(simRng, MIN_SPEED, MAX_SPEED);
        if (el) el.style.zIndex = '30';
        setMouth(r, 'smile');
      } else if (next === 'napping') {
        r.target = { ...r.pos };
        r.speed = 0;
        setMouth(r, 'flat');
        setEye(r, 0.08);
        r.blinkPhase = 'closed';
        if (el) el.style.zIndex = '30';
      } else if (next === 'glancing') {
        // Bias facing toward the cursor for the duration; keep current target.
        setMouth(r, 'smile');
      } else if (next === 'perched') {
        const t = pickPerchTarget();
        if (!t) return enterBehavior(r, 'wandering', now);
        r.target = t;
        r.speed = randRange(simRng, 60, 100);
        setMouth(r, 'smile');
        if (el) el.style.zIndex = '40';
      } else if (next === 'hiding') {
        const t = pickHideTarget();
        if (!t) return enterBehavior(r, 'wandering', now);
        r.target = t;
        r.speed = randRange(simRng, 40, 70);
        setMouth(r, 'smile');
        if (el) {
          r.zRestore = el.style.zIndex || '30';
          el.style.zIndex = '1';
          el.style.pointerEvents = 'none';
        }
      } else if (next === 'excursion') {
        r.target = pickExcursionTarget();
        r.speed = randRange(simRng, 60, 100);
        setMouth(r, 'smile');
        if (el) el.style.zIndex = '30';
      } else if (next === 'startled') {
        r.speed = SCATTER_SPEED;
        setMouth(r, 'o');
        setEye(r, 1);
        r.blinkPhase = 'open';
      }

      // Restore eye on leaving napping.
      if (prev === 'napping' && next !== 'napping') {
        setEye(r, 1);
        r.blinkPhase = 'open';
        r.nextBlinkAt = now + 2000 + simRng() * 3000;
      }
      // Restore z + pointer-events when leaving hiding.
      if (prev === 'hiding' && next !== 'hiding' && el) {
        el.style.zIndex = r.zRestore || '30';
        el.style.pointerEvents = '';
      }

      r.behavior = next;
    },
    [pickWanderTarget, pickExcursionTarget, setMouth, setEye]
  );

  // --- per-frame steps -------------------------------------------------------
  const stepMorph = useCallback(
    (r: EntityRuntime, neighborsSmooth: Array<{ x: number; y: number; z: number }>, dt: number, cfg: FishMorphConfig, now: number) => {
      const eff = applyGenotypeToConfig(r.genotype, cfg);
      const frameScale = clamp(dt / (1 / 60), 0.25, 4);
      const raw = lorenzStep(r.lorenz, eff.lorenzSpeed * frameScale);

      // Weak coupling: nudge toward the mean smoothed state of nearby fish so
      // neighbors morph in loose correlation while distant fish stay independent.
      if (neighborsSmooth.length > 0) {
        let mx = 0;
        let my = 0;
        let mz = 0;
        for (const s of neighborsSmooth) {
          mx += s.x;
          my += s.y;
          mz += s.z;
        }
        const k = neighborsSmooth.length;
        const c = COUPLING_STRENGTH * frameScale;
        raw.x += c * (mx / k - raw.x);
        raw.y += c * (my / k - raw.y);
        raw.z += c * (mz / k - raw.z);
      }
      r.lorenz = raw;

      const alpha = 1 - Math.pow(1 - cfg.smoothing, frameScale);
      const sm = r.lorenzSmooth;
      sm.x += alpha * (raw.x - sm.x);
      sm.y += alpha * (raw.y - sm.y);
      sm.z += alpha * (raw.z - sm.z);

      const morph = deriveMorph(sm, NUM_FISH_VARIANTS, eff);
      const bs = r.baseSize;
      const scaled: MorphOutputs = { ...morph, scaleX: morph.scaleX * bs, scaleY: morph.scaleY * bs };
      if (r.refs.morphGroup) r.refs.morphGroup.setAttribute('transform', morphTransform(scaled));
      if (r.refs.warp) r.refs.warp.setAttribute('scale', morph.warp.toFixed(3));
      if (now - r.lastPathAt >= 33 && r.refs.body) {
        r.lastPathAt = now;
        r.refs.body.setAttribute('d', buildBodyPath(morph.morphProgress));
      }
      // On-screen size for predation/overlap checks (squash preserves area, so
      // sqrt(scaleX*scaleY) is the breathing size; baseSize scales it).
      r.currentSize = bs * Math.sqrt(Math.max(morph.scaleX * morph.scaleY, 1e-4));
    },
    []
  );

  const seekTarget = useCallback((r: EntityRuntime, dt: number, speed: number) => {
    const dx = r.target.x - r.pos.x;
    const dy = r.target.y - r.pos.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 0.5) {
      const step = Math.min(speed * dt, dist);
      const nx = (dx / dist) * step;
      const ny = (dy / dist) * step;
      r.pos.x += nx;
      r.pos.y += ny;
      r.vel = { x: nx / dt, y: ny / dt };
    } else {
      r.vel = { x: 0, y: 0 };
    }
  }, []);

  const stepMotion = useCallback(
    (r: EntityRuntime, others: EntityRuntime[], dt: number, now: number, reduced: boolean) => {
      const b = bounds();

      if (reduced) {
        // Damped: drift gently toward a wander target, no boids/chase.
        seekTarget(r, dt, MAX_SPEED * 0.12);
        if (Math.hypot(r.target.x - r.pos.x, r.target.y - r.pos.y) < WANDER_RETARGET_DIST) {
          r.target = pickWanderTarget();
        }
      } else if (r.emigrating) {
        // Heading out for good; ignore social forces and edges.
        seekTarget(r, dt, MAX_SPEED);
      } else if (r.behavior === 'wandering') {
        const accel = computeSteering({ self: r, others, bounds: b, wanderTarget: r.target });
        r.vel.x += accel.x * dt;
        r.vel.y += accel.y * dt;
        let sp = vlen(r.vel);
        if (sp > MAX_SPEED) {
          r.vel.x = (r.vel.x / sp) * MAX_SPEED;
          r.vel.y = (r.vel.y / sp) * MAX_SPEED;
          sp = MAX_SPEED;
        }
        // Nudge a stalled fish along its desired heading so it never freezes.
        if (sp < MIN_SPEED) {
          const dx = r.target.x - r.pos.x;
          const dy = r.target.y - r.pos.y;
          const d = Math.hypot(dx, dy) || 1;
          r.vel.x = (dx / d) * MIN_SPEED;
          r.vel.y = (dy / d) * MIN_SPEED;
        }
        r.pos.x += r.vel.x * dt;
        r.pos.y += r.vel.y * dt;
        if (Math.hypot(r.target.x - r.pos.x, r.target.y - r.pos.y) < WANDER_RETARGET_DIST) {
          r.target = pickWanderTarget();
        }
      } else if (r.behavior === 'napping') {
        const bob = Math.sin(now / 700) * 1.5;
        r.pos.y = r.target.y + bob;
        r.vel = { x: 0, y: 0 };
      } else {
        // glancing / perched / hiding / excursion / startled
        seekTarget(r, dt, r.speed);
      }

      // Facing: cursor-biased while glancing, velocity-driven otherwise.
      if (r.behavior === 'glancing' && cursorRef.current.x >= 0) {
        const want: 1 | -1 = cursorRef.current.x < r.pos.x ? -1 : 1;
        if (want !== r.facing) {
          r.facing = want;
          applyFacing(r);
        }
      } else if (Math.abs(r.vel.x) > 8) {
        const want: 1 | -1 = r.vel.x < 0 ? -1 : 1;
        if (want !== r.facing) {
          r.facing = want;
          applyFacing(r);
        }
      }

      // Clamp to the viewport except when allowed to roam off-page.
      if (!r.emigrating && r.behavior !== 'excursion') {
        r.pos.x = clamp(r.pos.x, -SPRITE_W * 0.5, b.w - SPRITE_W * 0.5);
        r.pos.y = clamp(r.pos.y, -SPRITE_H * 0.5, b.h - SPRITE_H * 0.5);
      }

      if (r.refs.container) {
        r.refs.container.style.transform = `translate3d(${r.pos.x.toFixed(2)}px, ${r.pos.y.toFixed(2)}px, 0)`;
      }
    },
    [bounds, seekTarget, pickWanderTarget, applyFacing]
  );

  const stepBlink = useCallback(
    (r: EntityRuntime, now: number) => {
      if (r.behavior === 'napping' || r.behavior === 'startled') return;
      if (now < r.nextBlinkAt) return;
      if (r.blinkPhase === 'open') {
        r.blinkPhase = 'closing';
        r.nextBlinkAt = now + 80;
        setEye(r, 0.45);
      } else if (r.blinkPhase === 'closing') {
        r.blinkPhase = 'closed';
        r.nextBlinkAt = now + 90;
        setEye(r, 0.08);
      } else {
        r.blinkPhase = 'open';
        r.nextBlinkAt = now + 4000 + simRng() * 3000;
        setEye(r, 1);
      }
    },
    [setEye]
  );

  // --- event execution -------------------------------------------------------
  const executeEvent = useCallback(
    (ev: LifeEvent, now: number) => {
      const rts = runtimesRef.current;
      const count = () => rts.size;

      if (ev.type === 'birth-two-parent') {
        const pa = rts.get(ev.parentA);
        const pb = rts.get(ev.parentB);
        if (!pa || !pb) return;
        const views: EntityView[] = [];
        for (let i = 0; i < ev.litter && count() < POP_MAX; i++) {
          const genotype = mutateGenotype(blendGenotype(pa.genotype, pb.genotype, simRng), simRng);
          const pos: Vec2 = {
            x: (pa.pos.x + pb.pos.x) / 2 + randRange(simRng, -40, 40),
            y: (pa.pos.y + pb.pos.y) / 2 + randRange(simRng, -40, 40)
          };
          views.push(spawn(genotype, pos));
        }
        pa.reproCooldownUntil = now + reproCooldown();
        pb.reproCooldownUntil = now + reproCooldown();
        addEntities(views);
      } else if (ev.type === 'birth-budding') {
        const p = rts.get(ev.parent);
        if (!p || count() >= POP_MAX) return;
        const genotype = mutateGenotype(p.genotype, simRng);
        const pos: Vec2 = { x: p.pos.x + randRange(simRng, -36, 36), y: p.pos.y + randRange(simRng, -36, 36) };
        p.reproCooldownUntil = now + reproCooldown();
        addEntities([spawn(genotype, pos)]);
      } else if (ev.type === 'immigration') {
        if (count() >= POP_MAX) return;
        const { pos, target } = immigrantStart();
        addEntities([spawn(randomGenotype(simRng), pos, { target })]);
      } else if (ev.type === 'predation') {
        const pred = rts.get(ev.predator);
        const prey = rts.get(ev.prey);
        if (!pred || !prey) return;
        pred.baseSize = Math.min(pred.baseSize * PREDATION_GROWTH, PREDATION_MAX_BASESIZE);
        pred.postMealUntil = now + postMealCooldown();
        removeEntity(prey.id, 'chomp');
      } else if (ev.type === 'emigration') {
        const f = rts.get(ev.fish);
        if (!f) return;
        f.emigrating = true;
        f.target = offPageTarget();
        f.behavior = 'wandering';
      }
    },
    [spawn, addEntities, removeEntity, reproCooldown, postMealCooldown, immigrantStart, offPageTarget]
  );

  const runEventStep = useCallback(
    (now: number) => {
      const rts = Array.from(runtimesRef.current.values()).filter((r) => !pendingRemovalRef.current.has(r.id) && !r.emigrating);
      const ev = selectEvent(rts, now, simRng);
      if (ev.type === 'none') {
        nextEventAtRef.current = now + retryInterval();
        return;
      }
      executeEvent(ev, now);
      nextEventAtRef.current = now + eventInterval();
      if (DEBUG_FAST_EVENTS) setLastEvent(ev.type);
    },
    [executeEvent, eventInterval, retryInterval]
  );

  // --- founders --------------------------------------------------------------
  const ensureSeeded = useCallback(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const views: EntityView[] = [];
    for (let i = 0; i < INITIAL_POP; i++) {
      const genotype = randomGenotype(simRng);
      const pos: Vec2 = {
        x: ((i + 0.5) / INITIAL_POP) * Math.max(w - SPRITE_W, 1),
        y: h * 0.3 + simRng() * h * 0.4
      };
      const v = spawn(genotype, pos);
      views.push({ ...v, phase: 'alive' });
    }
    setEntities(views);
  }, [spawn]);

  // --- main rAF loop ---------------------------------------------------------
  useEffect(() => {
    if (paused) return;
    ensureSeeded();

    let raf = 0;
    const tick = (t: number) => {
      const dt = lastFrameRef.current ? clamp((t - lastFrameRef.current) / 1000, 0, 0.05) : 1 / 60;
      lastFrameRef.current = t;
      const cfg = configRef.current;
      const reduced = reducedMotionRef.current;

      const rts = Array.from(runtimesRef.current.values()).filter((r) => !pendingRemovalRef.current.has(r.id));

      // Snapshot smoothed-Lorenz + positions BEFORE updating, so neighbor
      // coupling is order-independent within a frame.
      const snap = rts.map((r) => ({ id: r.id, pos: r.pos, sm: { ...r.lorenzSmooth } }));

      // Pass 1: morph (sets currentSize used by chase/avoid in pass 2).
      for (const r of rts) {
        if (reduced) {
          resetMorph(r);
          continue;
        }
        // k nearest within radius, for coupling.
        const neighbors = snap
          .filter((s) => s.id !== r.id)
          .map((s) => ({ s, d: Math.hypot(s.pos.x - r.pos.x, s.pos.y - r.pos.y) }))
          .filter((n) => n.d < NEIGHBOR_RADIUS)
          .sort((a, z) => a.d - z.d)
          .slice(0, NEIGHBOR_K)
          .map((n) => n.s.sm);
        stepMorph(r, neighbors, dt, cfg, t);
      }

      // Pass 2: motion + blink.
      for (const r of rts) {
        const others = rts.filter((o) => o.id !== r.id);
        stepMotion(r, others, dt, t, reduced);
        if (!reduced) stepBlink(r, t);

        // Behavior expiry (skip while emigrating / reduced).
        if (!reduced && !r.emigrating && t >= r.behaviorEndsAt) {
          enterBehavior(r, pickWeighted(TRANSITIONS[r.behavior]), t);
        }

        // Emigrant fully off-page -> permanent despawn.
        if (r.emigrating) {
          const b = bounds();
          if (
            r.pos.x < -SPRITE_W * 2 ||
            r.pos.x > b.w + SPRITE_W * 2 ||
            r.pos.y < -SPRITE_H * 2 ||
            r.pos.y > b.h + SPRITE_H * 2
          ) {
            removeEntity(r.id, 'emigrate');
          }
        }
      }

      // Event clock.
      if (t >= nextEventAtRef.current) runEventStep(t);

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame((t) => {
      lastFrameRef.current = t;
      if (!nextEventAtRef.current) nextEventAtRef.current = t + eventInterval();
      tick(t);
    });

    return () => cancelAnimationFrame(raf);
  }, [
    paused,
    reducedMotion,
    ensureSeeded,
    stepMorph,
    stepMotion,
    stepBlink,
    enterBehavior,
    resetMorph,
    runEventStep,
    eventInterval,
    bounds,
    removeEntity
  ]);

  // --- cursor + reduced-motion + resize listeners ----------------------------
  useEffect(() => {
    if (paused) return;
    const onMove = (e: PointerEvent) => {
      cursorRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('pointermove', onMove, { passive: true });

    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mql.matches);
    const onMql = () => setReducedMotion(mql.matches);
    mql.addEventListener('change', onMql);

    const onResize = () => {
      const b = { w: window.innerWidth, h: window.innerHeight };
      for (const r of runtimesRef.current.values()) {
        if (r.emigrating) continue;
        r.pos.x = clamp(r.pos.x, 0, b.w - SPRITE_W);
        r.pos.y = clamp(r.pos.y, 0, b.h - SPRITE_H);
      }
    };
    window.addEventListener('resize', onResize);

    return () => {
      window.removeEventListener('pointermove', onMove);
      mql.removeEventListener('change', onMql);
      window.removeEventListener('resize', onResize);
    };
  }, [paused]);

  // Clear every tracked timeout on unmount so a dismiss/remount leaks nothing.
  useEffect(() => {
    const timeouts = timeoutsRef.current;
    return () => {
      for (const t of timeouts) clearTimeout(t);
      timeouts.clear();
    };
  }, []);

  // --- public actions --------------------------------------------------------
  const register = useCallback((id: number, refs: EntityRefs) => {
    const r = runtimesRef.current.get(id);
    if (!r) return;
    r.refs = refs;
    if (refs.container) {
      refs.container.style.transform = `translate3d(${r.pos.x}px, ${r.pos.y}px, 0)`;
      refs.container.style.zIndex = '30';
    }
    if (refs.facing) refs.facing.style.transform = `scaleX(${r.facing})`;
    if (refs.morphGroup) refs.morphGroup.removeAttribute('transform');
    if (refs.warp) refs.warp.setAttribute('scale', '0');
  }, []);

  const unregister = useCallback((id: number) => {
    const r = runtimesRef.current.get(id);
    if (r) r.refs = emptyRefs();
  }, []);

  const scatter = useCallback(
    (x: number, y: number) => {
      if (reducedMotionRef.current) return;
      const now = performance.now();
      for (const r of runtimesRef.current.values()) {
        if (r.emigrating || pendingRemovalRef.current.has(r.id)) continue;
        const dx = r.pos.x - x;
        const dy = r.pos.y - y;
        const dist = Math.hypot(dx, dy);
        if (dist > SCATTER_RADIUS) continue;
        const d = Math.max(dist, 1);
        r.target = { x: r.pos.x + (dx / d) * 200, y: r.pos.y + (dy / d) * 200 };
        enterBehavior(r, 'startled', now);
      }
    },
    [enterBehavior]
  );

  return { entities, register, unregister, scatter, debug: { population: entities.length, lastEvent } };
}
