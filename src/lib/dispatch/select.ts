import { mulberry32, seedFromString } from '@/lib/sort/reorder';
import { RECENCY_HALFLIFE_DAYS } from './config';
import type { SpecimenCandidate } from './types';

// Specimen selection. The band query (src/lib/db/queries/dispatch.ts) has already
// restricted candidates to a middle range of cosine distance from the trend; what
// is left is choosing one, with a preference for recent uploads but without ever
// making the older corpus ineligible.
//
// Both functions are pure so the weighting curve and the pick are testable.

const DAY_MS = 86_400_000;

// Exponential decay on upload age. A same-day image weighs 1, a 45-day-old image
// weighs ~0.37, a two-year-old image still weighs something. Never zero: the
// brief asked for a mild preference, not a cutoff.
export function recencyWeight(uploadedAt: Date, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - uploadedAt.getTime()) / DAY_MS);
  return Math.exp(-ageDays / RECENCY_HALFLIFE_DAYS);
}

// Weighted pick with a deterministic seed, so re-running the same day (a retry, a
// review run, a replay) selects the same specimen instead of quietly shopping for
// a different one. Returns null for an empty pool -- the caller skips the day.
export function pickSpecimen(
  candidates: SpecimenCandidate[],
  opts: { seed: string; now: Date }
): SpecimenCandidate | null {
  if (candidates.length === 0) return null;

  const weights = candidates.map((c) => recencyWeight(c.uploadedAt, opts.now));
  const total = weights.reduce((a, b) => a + b, 0);
  // Degenerate case (all weights underflowed to 0 on a very old corpus): fall
  // back to a uniform pick rather than always returning the first row.
  if (!(total > 0)) {
    const idx = Math.floor(mulberry32(seedFromString(opts.seed))() * candidates.length);
    return candidates[Math.min(idx, candidates.length - 1)]!;
  }

  let target = mulberry32(seedFromString(opts.seed))() * total;
  for (let i = 0; i < candidates.length; i++) {
    target -= weights[i]!;
    if (target <= 0) return candidates[i]!;
  }
  return candidates[candidates.length - 1]!;
}
