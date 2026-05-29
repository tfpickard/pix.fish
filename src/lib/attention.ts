// Attention model: stigmergy for the gallery.
//
// "Attention" is an aggregate, anonymous measure of how long images linger on
// visitors' screens (see /api/attention + the client telemetry in
// infinite-image-grid.tsx). It is stored per image in `image_attention` as a
// single accumulated `value` plus the `lastUpdatedAt` timestamp of the last
// bump.
//
// The score decays exponentially with time so that yesterday's spike fades and
// recent interest dominates. We never run a cron to do this: decay is a pure
// function of (value, lastUpdatedAt, now), so it is computed lazily at read
// time (and, equivalently, applied in SQL during an atomic bump). This keeps
// the stored state tiny and the math centralized here.
//
// Privacy: nothing in this module is PII. `value` is a sum of dwell weights
// keyed only by imageId. See /api/attention for the collection posture (Do Not
// Track + explicit opt-out fully disable ingest).
//
// Reuse note: feat/alive consumes `decayed()` as a fitness signal, so this is
// kept a clean, dependency-free export -- no DB, no React, no env reads.

// Half-life of the attention score, in milliseconds.
//
// Rationale: the gallery is a slow medium. People visit over days, not
// seconds, and we want the "drifting" order to reflect roughly the last week
// of interest rather than a single busy afternoon or a stale month. Three days
// means a burst of attention loses half its weight in 3 days and ~88% of it in
// ~9 days, so an image needs sustained (not one-off) interest to keep nudging
// the order. Tunable: lower it to make the gallery more reactive/faddish,
// raise it to make popularity stickier.
export const ATTENTION_HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

// Exponential decay of a stored attention value to a reference time:
//
//   decayed = value * 0.5 ** ((now - lastUpdatedAt) / halfLife)
//
// `now` and `lastUpdatedAt` are epoch-millisecond timestamps. If the stored
// timestamp is somehow in the future (clock skew), elapsed is clamped to 0 so
// we never amplify a value above what was stored.
export function decayed(
  value: number,
  lastUpdatedAt: number,
  now: number,
  halfLifeMs: number = ATTENTION_HALF_LIFE_MS
): number {
  if (value <= 0) return 0;
  const elapsed = Math.max(0, now - lastUpdatedAt);
  return value * Math.pow(0.5, elapsed / halfLifeMs);
}

// Normalize a map of raw decayed attention values into the 0..1 range by
// dividing by the current maximum. This makes the bias scale-free: it does not
// matter whether the busiest image has a score of 5 or 5000, the most popular
// image always normalizes to 1.0 and everything else is relative to it. An
// empty or all-zero map yields an empty map (no bias to apply).
//
// We normalize against the *visible candidate set*, not globally, so the nudge
// is computed relative to the images actually competing for position.
export function normalizeAttention(
  raw: Map<number, number>
): Map<number, number> {
  let max = 0;
  for (const v of raw.values()) {
    if (v > max) max = v;
  }
  const out = new Map<number, number>();
  if (max <= 0) return out;
  for (const [id, v] of raw) {
    if (v > 0) out.set(id, v / max);
  }
  return out;
}
