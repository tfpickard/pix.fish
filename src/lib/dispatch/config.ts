// Outbound X dispatch: every cost, abuse, and blast-radius guard in one file.
//
// The feature posts at most ONE image per day to the site's X account, tagged
// into a trending topic with a caption engineered to miss that topic. Nothing
// here may be capable of spinning: no retry loops, no unbounded token budgets,
// no schedule that can fire twice. Constants are exported (not inlined) so
// tests/dispatch.test.ts can assert the guards are enforced rather than merely
// intended -- same posture as src/lib/ai/pisci-chat.ts.

// ---- posting mode ---------------------------------------------------------

// Dry run is the default and stays the default regardless of credentials. Live
// posting requires BOTH an explicit env opt-in and a full credential set; the
// switch is flipped by hand, later, after captions have been reviewed.
export function dispatchLiveEnabled(): boolean {
  return process.env.X_DISPATCH_LIVE === 'true';
}

// ---- caption shape --------------------------------------------------------

// Hard ceiling on caption length including the hashtag. 280 is the X limit for
// a non-Premium account; a Premium account can post far longer, which the drift
// variant genuinely wants (it needs room to wander before the reader realizes
// it was never on topic). Kept as a constant plus env override so the budget can
// be raised without a code change if the account ever gets Premium.
export const DEFAULT_CAPTION_CHAR_BUDGET = 280;
// Above this we would be trusting an unverified env value with the post body, so
// clamp: X Premium tops out at 4000 characters.
const MAX_CAPTION_CHAR_BUDGET = 4000;

export function captionCharBudget(): number {
  const raw = Number(process.env.X_DISPATCH_CHAR_BUDGET);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_CAPTION_CHAR_BUDGET;
  return Math.min(Math.trunc(raw), MAX_CAPTION_CHAR_BUDGET);
}

// At most two hashtags, per the tone contract. A hashtag wall kills the register,
// so the generator is told one and the validator enforces the ceiling.
export const MAX_HASHTAGS = 2;

// ---- LLM budgets ----------------------------------------------------------

// Bounded output on every call. The classifier emits a small JSON array; the
// caption is at most a few hundred characters. Neither needs headroom, and an
// unbounded max_tokens on a daily job is exactly the kind of thing that quietly
// costs money for a year before anyone looks.
export const SAFETY_MAX_TOKENS = 700;
export const CAPTION_MAX_TOKENS = 400;

// Per-call deadlines. Both sit well inside the worker's per-job timeout for
// 'x.dispatch' (see src/lib/jobs/worker.ts) so a slow provider aborts here and
// the day is skipped rather than the job being killed mid-flight.
export const SAFETY_TIMEOUT_MS = 20_000;
export const CAPTION_TIMEOUT_MS = 20_000;

// ---- trend acquisition ----------------------------------------------------

export const TREND_FETCH_TIMEOUT_MS = 10_000;
// How many feed items to consider. The feed returns ~20; classifying more than
// this buys nothing and costs tokens.
export const MAX_TREND_CANDIDATES = 12;
// Headlines carried into the classifier and the caption prompt per trend. Two is
// enough to disambiguate what a topic is actually about.
export const MAX_HEADLINES_PER_TREND = 3;

// ---- specimen selection ---------------------------------------------------

// The middle band of cosine distance between the trend text and a caption
// embedding. Below MIN the specimen is genuinely about the trend, which kills the
// joke; above MAX there is no thread at all and the result reads as random.
export const BAND_MIN_DISTANCE = 0.55;
export const BAND_MAX_DISTANCE = 0.8;
// One widening pass if the tight band is empty. Still empty means no post today.
export const WIDE_BAND_MIN_DISTANCE = 0.45;
export const WIDE_BAND_MAX_DISTANCE = 0.9;

// Recency preference. The whole corpus is eligible, but weight decays with age so
// recent uploads are favoured without ever excluding the archive. At 45 days an
// image carries ~37% of a same-day image's weight; it never reaches zero.
export const RECENCY_HALFLIFE_DAYS = 45;
// Cap the candidate set pulled into memory for weighting. The corpus is a few
// thousand rows today; this keeps the job's footprint flat as it grows.
export const MAX_POOL_CANDIDATES = 600;

// ---- schedule -------------------------------------------------------------

// Base fire time in UTC minutes-from-midnight (18:17 UTC, roughly 1pm ET): late
// enough that the day's trends have formed, early enough that they are not stale.
export const DISPATCH_BASE_UTC_MINUTE = 18 * 60 + 17;
// Typical jitter around the base, and the rare wider excursion. The dispatch
// should not look like a machine firing on a cron.
export const DISPATCH_JITTER_TYPICAL_MIN = 60;
export const DISPATCH_JITTER_TAIL_MIN = 240;
// Share of days that take the wide excursion instead of the typical one.
export const DISPATCH_TAIL_PROBABILITY = 0.1;
