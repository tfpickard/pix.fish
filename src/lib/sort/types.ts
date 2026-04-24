// Sort modes for the public gallery. Every mode is deterministic given
// (sort, seed, tag-filter); non-seeded modes ignore `seed`.
//
// Three groups drive <optgroup> labels in sort-bar.tsx and the dropdown in
// /admin/gallery. Adding a mode means:
//   - append its id to SortMode
//   - add a SORT_META entry (label shows in the UI, description shows as a
//     hover title)
//   - wire it in src/lib/db/queries/images.ts listImages dispatch

export type SortMode =
  | 'drifting'
  | 'newest'
  | 'oldest'
  | 'ancient-drift'
  | 'random'
  | 'clumped'
  | 'anti-clumped'
  | 'rainbow'
  | 'chronograph'
  | 'memory-lane'
  | 'lonely'
  | 'drunkards-walk'
  | 'tidal';

export const DEFAULT_SORT: SortMode = 'drifting';

export type SortGroup = 'familiar' | 'dispersion' | 'weird';

export type SortMeta = {
  id: SortMode;
  label: string;
  description: string;
  group: SortGroup;
  // Reshuffles when `seed` changes. Drives whether the sort-bar mints a new
  // seed on each auto-shuffle tick.
  randomSeeded: boolean;
  // Needs caption embeddings to produce a meaningful order. Modes flagged
  // here gracefully fall back to uploadedAt ordering for rows missing a
  // vector, so nothing breaks if the embedding job hasn't caught up.
  needsEmbeddings: boolean;
};

export const SORT_META: Record<SortMode, SortMeta> = {
  drifting: {
    id: 'drifting',
    label: 'Drifting (default)',
    description: 'Newest first, but visually similar bursts are spread apart',
    group: 'dispersion',
    randomSeeded: false,
    needsEmbeddings: true
  },
  newest: {
    id: 'newest',
    label: 'Newest',
    description: 'Strict upload order, newest first',
    group: 'familiar',
    randomSeeded: false,
    needsEmbeddings: false
  },
  oldest: {
    id: 'oldest',
    label: 'Oldest',
    description: 'Strict upload order, oldest first',
    group: 'familiar',
    randomSeeded: false,
    needsEmbeddings: false
  },
  'ancient-drift': {
    id: 'ancient-drift',
    label: 'Oldest, drifting',
    description: 'Oldest first, similar bursts spread apart',
    group: 'dispersion',
    randomSeeded: false,
    needsEmbeddings: true
  },
  random: {
    id: 'random',
    label: 'Random',
    description: 'Fresh shuffle; reshuffles with each new seed',
    group: 'familiar',
    randomSeeded: true,
    needsEmbeddings: false
  },
  clumped: {
    id: 'clumped',
    label: 'Clumped',
    description: 'Similar images cluster together, clusters by newest first',
    group: 'dispersion',
    randomSeeded: false,
    needsEmbeddings: true
  },
  'anti-clumped': {
    id: 'anti-clumped',
    label: 'Anti-clumped',
    description: 'Maximum visual spread; each next image looks least like what came before',
    group: 'dispersion',
    randomSeeded: false,
    needsEmbeddings: true
  },
  rainbow: {
    id: 'rainbow',
    label: 'Rainbow',
    description: 'Walk of the dominant palette hue, warm through cool',
    group: 'weird',
    randomSeeded: false,
    needsEmbeddings: false
  },
  chronograph: {
    id: 'chronograph',
    label: 'Time of day',
    description: 'A full day from midnight to midnight, regardless of year',
    group: 'weird',
    randomSeeded: false,
    needsEmbeddings: false
  },
  'memory-lane': {
    id: 'memory-lane',
    label: 'Memory lane',
    description: 'Camera time (EXIF), not upload time -- actual lived chronology',
    group: 'weird',
    randomSeeded: false,
    needsEmbeddings: false
  },
  lonely: {
    id: 'lonely',
    label: 'Lonely first',
    description: 'Underseen images: fewest reactions and comments up top',
    group: 'weird',
    randomSeeded: false,
    needsEmbeddings: false
  },
  'drunkards-walk': {
    id: 'drunkards-walk',
    label: "Drunkard's walk",
    description: 'A wandering tour through embedding space with occasional long jumps',
    group: 'weird',
    randomSeeded: true,
    needsEmbeddings: true
  },
  tidal: {
    id: 'tidal',
    label: 'Tidal',
    description: 'Interleaves newest and oldest; breathing in and out across the archive',
    group: 'weird',
    randomSeeded: false,
    needsEmbeddings: false
  }
};

export const SORT_MODES: SortMeta[] = Object.values(SORT_META);

export function isSortMode(value: string | null | undefined): value is SortMode {
  return typeof value === 'string' && value in SORT_META;
}

// Auto-shuffle cadence selector. `off` disables the interval; the other
// tokens are parsed by parseShufflePeriodMs().
export type ShufflePeriod = 'off' | '15s' | '30s' | '1m' | '5m' | '15m';

export const DEFAULT_SHUFFLE_PERIOD: ShufflePeriod = 'off';

export const SHUFFLE_PERIODS: { id: ShufflePeriod; label: string }[] = [
  { id: 'off', label: 'off' },
  { id: '15s', label: 'every 15 seconds' },
  { id: '30s', label: 'every 30 seconds' },
  { id: '1m', label: 'every minute' },
  { id: '5m', label: 'every 5 minutes' },
  { id: '15m', label: 'every 15 minutes' }
];

export function isShufflePeriod(value: string | null | undefined): value is ShufflePeriod {
  return typeof value === 'string' && SHUFFLE_PERIODS.some((p) => p.id === value);
}

export function parseShufflePeriodMs(period: ShufflePeriod): number | null {
  switch (period) {
    case 'off':
      return null;
    case '15s':
      return 15_000;
    case '30s':
      return 30_000;
    case '1m':
      return 60_000;
    case '5m':
      return 5 * 60_000;
    case '15m':
      return 15 * 60_000;
  }
}

// The candidate window size for reorder-in-memory sorts. Everything within
// the top N (by recency, depending on mode) gets reordered; older rows are
// appended in raw recency order if the requested offset spills past N.
export const CANDIDATE_CAP = 300;
