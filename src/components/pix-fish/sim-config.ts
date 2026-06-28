// All simulation tunables for the pix.fish artificial-life tank, grouped in one
// place so the whole sim can be retuned from a single file. These govern the
// POPULATION and BEHAVIOR layer. The per-fish SHAPE morph knobs (drift speed,
// smoothing, scale band, squash, skew, warp) are a separate concern and stay in
// the admin-editable global `FishMorphConfig` (src/lib/fish/config.ts); each
// fish's genotype only *modulates* those.

// ---------------------------------------------------------------------------
// Debug
// ---------------------------------------------------------------------------

// When true, the event clock fires every ~5-10s instead of every 3-6min, and a
// small overlay shows population + the last life event. Ship OFF.
export const DEBUG_FAST_EVENTS = false;

// ---------------------------------------------------------------------------
// Population shaping -- target ~N(POP_MEAN, POP_SIGMA) hard-clamped [MIN, MAX].
// 3-6 common, 2/7 occasional, 8 unlikely, 1/9 very unlikely. Achieved by the
// pressure-to-weight gain in event selection, not by spawning to a fixed count.
// ---------------------------------------------------------------------------

export const POP_MIN = 1;
export const POP_MAX = 9;
export const POP_MEAN = 4.5;
export const POP_SIGMA = 1.3;

// How many fish to seed the tank with on first mount.
export const INITIAL_POP = 4;

// ---------------------------------------------------------------------------
// Event clock -- one scheduler, mean cadence 3-6 min.
// ---------------------------------------------------------------------------

export const EVENT_INTERVAL_MIN = 180_000; // 3 min
export const EVENT_INTERVAL_MAX = 360_000; // 6 min
export const EVENT_INTERVAL_MIN_FAST = 5_000;
export const EVENT_INTERVAL_MAX_FAST = 10_000;

// If no event is valid when the clock fires, retry sooner rather than forcing an
// implausible event.
export const EVENT_RETRY_MIN = 10_000;
export const EVENT_RETRY_MAX = 20_000;
export const EVENT_RETRY_MIN_FAST = 1_500;
export const EVENT_RETRY_MAX_FAST = 3_000;

// Maps (POP_MEAN - count) to a multiplicative weight bias. Higher gain => the
// population is pulled toward the mean harder, narrowing the distribution.
export const POP_PRESSURE_GAIN = 0.8;

// ---------------------------------------------------------------------------
// Birth
// ---------------------------------------------------------------------------

// Two-parent reproduction is the favored birth path: its base weight is
// multiplied by this relative to budding.
export const TWO_PARENT_BIAS = 4;
export const BUD_BASE_PROB = 0.3;
// Budding weight multiplier when count <= BUD_LOWPOP_THRESHOLD -- the
// "life finds a way" anti-extinction failsafe.
export const BUD_LOWPOP_BOOST = 12;
export const BUD_LOWPOP_THRESHOLD = 2;

// A litter is 1-2 kids (inclusive range).
export const LITTER_MIN = 1;
export const LITTER_MAX = 2;

// Two fish must be within this many px to count as a breeding pair.
export const BREED_PROXIMITY = 160;

// Immigration: a stray swims in from off-page. Disable to make the tank closed.
export const ALLOW_IMMIGRATION = true;
export const IMMIGRATION_BASE_WEIGHT = 0.25;

// ---------------------------------------------------------------------------
// Genotype inheritance
// ---------------------------------------------------------------------------

// Per trait, probability it mutates at all on a birth, and the std-dev of the
// gaussian nudge (in trait units) when it does.
export const MUTATION_RATE = 0.5;
export const MUTATION_SCALE = 0.12;

// ---------------------------------------------------------------------------
// Lorenz coupling -- weak pull of each fish's attractor toward the mean of its
// neighbors so near fish morph in loose correlation. 0 = fully independent.
// ---------------------------------------------------------------------------

export const COUPLING_STRENGTH = 0.06;
export const NEIGHBOR_K = 3;
// Neighbor influence (coupling + alignment/cohesion) only counts fish within
// this radius (px).
export const NEIGHBOR_RADIUS = 240;

// ---------------------------------------------------------------------------
// Boids steering -- default per-fish weights and the slow random-walk drift
// range applied to each fish's live weights so schools and loners emerge.
// ---------------------------------------------------------------------------

export const BOIDS_DEFAULTS = {
  separation: 1.4,
  alignment: 0.7,
  cohesion: 0.5
} as const;

// Each weight drifts within +/- this fraction of its default over time.
export const BOIDS_DRIFT_RANGE = 0.5;
// Per-second std-dev of the weight random walk.
export const BOIDS_DRIFT_RATE = 0.04;

// Desired neighbor spacing; closer than this triggers separation.
export const SEPARATION_RADIUS = 90;

// Wander (the old random-target seek, now a steering force).
export const WANDER_WEIGHT = 0.9;
export const WANDER_RETARGET_DIST = 28; // repick wander target within this px

// Chase / avoid (predator/prey temperament).
export const CHASE_WEIGHT = 1.1;
export const AVOID_WEIGHT = 1.6;
export const CHASE_RADIUS = 220;
// A fish only chases/avoids another whose size differs by at least this ratio.
export const CHASE_SIZE_RATIO = 1.12;
// Temperament magnitude above which chase/avoid kicks in (|temperament|).
export const TEMPERAMENT_DEADZONE = 0.15;

// Soft edges -- fish feel a turn-back force within this margin of the bounds.
export const EDGE_MARGIN = 80;
export const EDGE_WEIGHT = 2.2;

// ---------------------------------------------------------------------------
// Reduced motion -- when prefers-reduced-motion is set we keep the tank ALIVE
// (slow organic morph + a calm swim) rather than freezing it, but scale the
// morph intensity/speed down and drop the jarring bits: the click-scatter burst
// (gated off in scatter()), fast chase/predation darts (reduced fish use the
// plain-wander path, no boids), and the CSS enter/exit scale flash (handled by
// motion-reduce:transition-none in fish-entity.tsx).
// ---------------------------------------------------------------------------

// Fraction of normal Lorenz drift speed kept for the morph under reduced motion.
export const REDUCED_MORPH_SPEED_SCALE = 0.5;
// Fraction of the squash/skew/warp amounts kept under reduced motion.
export const REDUCED_MORPH_AMOUNT_SCALE = 0.6;
// Calm swim speed under reduced motion, as a fraction of MAX_SPEED.
export const REDUCED_SWIM_SCALE = 0.32;

// Movement integration.
export const MAX_SPEED = 78; // px/s cruising cap
export const MIN_SPEED = 26; // px/s -- nudge along if a fish stalls while wandering
export const MAX_FORCE = 220; // px/s^2 steering accel cap
export const SCATTER_SPEED = 260; // px/s flee speed on click
export const SCATTER_RADIUS = 220; // click affects fish within this px

// ---------------------------------------------------------------------------
// Predation -- death by being eaten.
// ---------------------------------------------------------------------------

// Predator must be at least this much bigger than the (current) prey size.
export const PREDATION_SIZE_RATIO = 1.35;
// And the two must overlap within this px for the chomp to be plausible.
export const PREDATION_OVERLAP = 120;
// The predator's baseSize grows by this factor after a meal, capped.
export const PREDATION_GROWTH = 1.12;
export const PREDATION_MAX_BASESIZE = 1.9;

// ---------------------------------------------------------------------------
// Emigration -- permanent departure off-page.
// ---------------------------------------------------------------------------

// Only fish with wanderlust above this are eligible to emigrate.
export const EMIGRATION_WANDERLUST_MIN = 0.6;
export const EMIGRATION_BASE_WEIGHT = 1;

// ---------------------------------------------------------------------------
// Cooldowns (ms).
// ---------------------------------------------------------------------------

export const REPRO_COOLDOWN = 45_000;
export const REPRO_COOLDOWN_FAST = 6_000;
export const POST_MEAL_COOLDOWN = 30_000;
export const POST_MEAL_COOLDOWN_FAST = 5_000;

// ---------------------------------------------------------------------------
// Enter / exit animation timing (ms). Births fade+scale in; deaths/departures
// fade out. The runtime is not torn down until EXIT_MS elapses.
// ---------------------------------------------------------------------------

export const ENTER_MS = 700;
export const EXIT_MS = 600;

// ---------------------------------------------------------------------------
// Performance -- cap the count of fish that get the (expensive) SVG
// displacement warp; the rest fall back to cheap squash/stretch only.
// ---------------------------------------------------------------------------

export const MAX_FILTERED_FISH = 6;

// ---------------------------------------------------------------------------
// Sprite geometry (mirrors the constants the single-fish brain used).
// ---------------------------------------------------------------------------

export const SPRITE_W = 72;
export const SPRITE_H = 43;

// How far off-page an emigrant/immigrant target sits.
export const OFFPAGE_MARGIN = 90;
