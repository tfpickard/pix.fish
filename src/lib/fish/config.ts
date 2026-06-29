// Tunable parameters for the pix-fish mascot's Lorenz-driven shape + size morph.
//
// These used to be hardcoded constants in `lorenz.ts`. They now live in the
// `fish_config` table (global, site-wide) and are edited at /admin/fish, so the
// look can be tuned without a redeploy. This module is the single source of
// truth: it declares each parameter once (key, db field, label, default, slider
// bounds) and everything else -- the morph engine defaults, the admin UI, the
// query loader, the API validation, and the seed -- derives from it.
//
// Pure data + helpers only (no React, no db imports) so both client and server
// can import it.

export interface FishMorphConfig {
  // How fast the attractor advances per 60fps frame. Lower => lazier, more
  // hypnotic drift.
  lorenzSpeed: number;
  // EMA factor smoothing every mapped output. Lower => silkier/slower.
  smoothing: number;
  // Uniform size band the fish breathes between.
  scaleMin: number;
  scaleMax: number;
  // Non-uniform squash/stretch magnitude (area roughly preserved).
  squashAmount: number;
  // Lean, in degrees.
  skewAmount: number;
  // Organic outline warp (feDisplacementMap scale). 0 disables the warp filter.
  warpAmount: number;
  // feTurbulence frequency: higher => finer, more crinkly outline wiggle.
  warpBaseFrequency: number;
  // feTurbulence octaves (integer).
  warpOctaves: number;
  // Population limits (sim layer; stored here so the admin panel can tune them).
  popMin: number;
  popMax: number;
  popMean: number;
  // Immigration weight (0 disables; 0.25 is the default rate).
  immigrationWeight: number;
  // Life-event cadence, in SECONDS. The clock fires on a uniform draw in
  // [eventIntervalMin, eventIntervalMax]; lower => a livelier tank.
  eventIntervalMin: number;
  eventIntervalMax: number;
  // Relative weight of a fish eating a much smaller neighbor (0 disables).
  predationWeight: number;
  // Relative weight of two close fish fighting (0 disables).
  fightWeight: number;
  // Probability (0..1) a fight escalates and kills the loser (guarded so the
  // tank never empties).
  fightLethalChance: number;
  // Relative weight of a fish dying of natural causes (0 disables).
  deathWeight: number;
  // Probability (0..1) a death (natural or lethal fight) is a burst/explode
  // rather than a slow sink-and-fade.
  explodeRatio: number;
}

export interface FishParamSpec {
  key: keyof FishMorphConfig;
  // Snake-case identifier used as the db `field` and the API key.
  field: string;
  label: string;
  default: number;
  min: number;
  max: number;
  step: number;
  integer?: boolean;
  hint?: string;
}

// The ordered list of tunables. Order is the display order on /admin/fish.
export const FISH_PARAMS: FishParamSpec[] = [
  {
    key: 'lorenzSpeed',
    field: 'lorenz_speed',
    label: 'drift speed',
    default: 0.0042,
    min: 0.0005,
    max: 0.02,
    step: 0.0001,
    hint: 'how fast the morph wanders -- lower is lazier/more hypnotic'
  },
  {
    key: 'smoothing',
    field: 'smoothing',
    label: 'smoothing',
    default: 0.06,
    min: 0.01,
    max: 0.3,
    step: 0.01,
    hint: 'silkiness of transitions -- lower is smoother/slower'
  },
  {
    key: 'scaleMin',
    field: 'scale_min',
    label: 'size min',
    default: 0.85,
    min: 0.5,
    max: 1,
    step: 0.01,
    hint: 'smallest the fish breathes down to'
  },
  {
    key: 'scaleMax',
    field: 'scale_max',
    label: 'size max',
    default: 1.15,
    min: 1,
    max: 1.6,
    step: 0.01,
    hint: 'largest the fish breathes up to'
  },
  {
    key: 'squashAmount',
    field: 'squash_amount',
    label: 'squash / stretch',
    default: 0.3,
    min: 0,
    max: 0.6,
    step: 0.01,
    hint: 'non-uniform stretch; 0 keeps the fish round'
  },
  {
    key: 'skewAmount',
    field: 'skew_amount',
    label: 'skew (deg)',
    default: 12,
    min: 0,
    max: 30,
    step: 1,
    hint: 'how far the body leans'
  },
  {
    key: 'warpAmount',
    field: 'warp_amount',
    label: 'outline warp',
    default: 9,
    min: 0,
    max: 16,
    step: 0.5,
    hint: 'organic outline wobble; 0 disables the warp filter entirely'
  },
  {
    key: 'warpBaseFrequency',
    field: 'warp_base_frequency',
    label: 'warp detail',
    default: 0.025,
    min: 0.005,
    max: 0.06,
    step: 0.001,
    hint: 'higher = finer, crinklier wobble'
  },
  {
    key: 'warpOctaves',
    field: 'warp_octaves',
    label: 'warp octaves',
    default: 2,
    min: 1,
    max: 3,
    step: 1,
    integer: true,
    hint: 'turbulence layers'
  },
  // Population shaping
  {
    key: 'popMin',
    field: 'pop_min',
    label: 'min fish',
    default: 1,
    min: 1,
    max: 5,
    step: 1,
    integer: true,
    hint: 'tank never drops below this many fish'
  },
  {
    key: 'popMax',
    field: 'pop_max',
    label: 'max fish',
    default: 9,
    min: 3,
    max: 16,
    step: 1,
    integer: true,
    hint: 'tank never exceeds this many fish'
  },
  {
    key: 'popMean',
    field: 'pop_mean',
    label: 'target population',
    default: 4.5,
    min: 1,
    max: 12,
    step: 0.5,
    hint: 'event pressure pulls the population toward this number'
  },
  {
    key: 'immigrationWeight',
    field: 'immigration_weight',
    label: 'immigration',
    default: 0.25,
    min: 0,
    max: 2,
    step: 0.05,
    hint: 'relative weight of new fish swimming in from off-screen; 0 disables'
  },
  // Life-event cadence + interaction weights
  {
    key: 'eventIntervalMin',
    field: 'event_interval_min',
    label: 'event gap min (s)',
    default: 25,
    min: 3,
    max: 600,
    step: 1,
    integer: true,
    hint: 'shortest wait between life events -- lower means a livelier tank'
  },
  {
    key: 'eventIntervalMax',
    field: 'event_interval_max',
    label: 'event gap max (s)',
    default: 70,
    min: 5,
    max: 1200,
    step: 1,
    integer: true,
    hint: 'longest wait between life events'
  },
  {
    key: 'predationWeight',
    field: 'predation_weight',
    label: 'eat',
    default: 1,
    min: 0,
    max: 4,
    step: 0.1,
    hint: 'relative weight of a big fish eating a much smaller neighbor; 0 disables'
  },
  {
    key: 'fightWeight',
    field: 'fight_weight',
    label: 'fight',
    default: 0.8,
    min: 0,
    max: 4,
    step: 0.1,
    hint: 'relative weight of two close fish scuffling; 0 disables'
  },
  {
    key: 'fightLethalChance',
    field: 'fight_lethal_chance',
    label: 'fight lethality',
    default: 0.25,
    min: 0,
    max: 1,
    step: 0.05,
    hint: 'chance a fight kills the loser (never below min fish); 0 = always survivable'
  },
  {
    key: 'deathWeight',
    field: 'death_weight',
    label: 'natural death',
    default: 0.5,
    min: 0,
    max: 4,
    step: 0.1,
    hint: 'relative weight of a fish dying of old age (never below min fish); 0 disables'
  },
  {
    key: 'explodeRatio',
    field: 'explode_ratio',
    label: 'explode vs sink',
    default: 0.5,
    min: 0,
    max: 1,
    step: 0.05,
    hint: 'of deaths, the fraction that burst/explode rather than sink and fade'
  }
];

function buildDefaults(): FishMorphConfig {
  const cfg = {} as FishMorphConfig;
  for (const p of FISH_PARAMS) {
    // Number indexing is safe: every FishParamSpec.key is a numeric field.
    cfg[p.key] = p.default;
  }
  return cfg;
}

export const DEFAULT_FISH_MORPH_CONFIG: FishMorphConfig = buildDefaults();

// Clamp a raw value to a spec's bounds, rounding integers and falling back to
// the default for anything non-finite. Used everywhere a value enters the
// system (db read, API write) so an out-of-range value can never reach the
// morph engine.
export function clampParam(spec: FishParamSpec, raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return spec.default;
  const clamped = Math.max(spec.min, Math.min(spec.max, n));
  return spec.integer ? Math.round(clamped) : clamped;
}

// Build a validated FishMorphConfig from a loose field -> value map (db rows or
// an API body). Missing/invalid fields fall back to their default.
export function fishConfigFromFields(values: Record<string, unknown>): FishMorphConfig {
  const cfg = {} as FishMorphConfig;
  for (const p of FISH_PARAMS) {
    const raw = p.field in values ? values[p.field] : undefined;
    cfg[p.key] = raw === undefined ? p.default : clampParam(p, raw);
  }
  return cfg;
}

// Serialize a config to the field -> string map used for persistence/seeding.
export function fishConfigToFields(cfg: FishMorphConfig): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of FISH_PARAMS) {
    out[p.field] = String(cfg[p.key]);
  }
  return out;
}
