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

// Bounded output on every call. An unbounded max_tokens on a daily job is
// exactly the kind of thing that quietly costs money for a year before anyone
// looks -- so these stay caps. But a cap that is too SMALL does not save
// anything: the call is billed either way and the day is lost, converting the
// whole spend into waste. These are sized to be sufficient first and bounded
// second, which is the opposite of how they were originally picked.
//
// Two things have to fit under the cap, and the second is easy to forget:
//
//   1. The visible output. The classifier judges up to MAX_TREND_CANDIDATES (12)
//      topics in ONE batched call, emitting a JSON object per topic --
//      {"index":0,"safe":true,"category":"brand-fail","confidence":"high",...}
//      -- at roughly 40 tokens each, so ~480 for a full batch. The caption is a
//      few hundred characters.
//
//   2. EXTENDED THINKING, on any model that does it. Thinking tokens are drawn
//      from this same budget and are spent BEFORE any text is produced, so an
//      undersized cap does not truncate the answer -- it can consume the entire
//      budget and return a response with no text block at all. The `dispatch`
//      ai_config row is repointable from /admin/ai (Haiku by default, but a
//      thinking-class model is a legitimate choice for caption quality), so this
//      is a configuration the operator can reach, not a hypothetical.
//
// That second case is why 700 failed in two different-looking ways on the same
// model: sometimes the budget was gone before any text (no text block),
// sometimes thinking finished with just enough left to emit a truncated array
// (unparseable JSON). One cause, two symptoms, neither naming it.
//
// So both caps clear a realistic thinking budget plus the output. Still bounded,
// still cheap for a once-a-day job, and now sufficient for the models the admin
// UI actually allows.
export const SAFETY_MAX_TOKENS = 4000;
export const CAPTION_MAX_TOKENS = 2000;

// Per-call deadlines. These run SEQUENTIALLY, so what matters is their sum plus
// the embed and the DB work, measured against the worker's per-job timeout for
// 'x.dispatch' (50s, see src/lib/jobs/worker.ts).
//
// They were 10 + 20 + 20 = 50s, exactly the outer budget with nothing left for
// the embedding call or the queries. That is worse than it sounds: withTimeout
// rejects the job WITHOUT cancelling the work underneath, so a run that merely
// approached its inner limits would be marked failed from the outside, after the
// day-claim was written and before any outcome event -- the claimed-with-no-
// outcome case, reached by a slow-but-otherwise-successful run rather than a
// bug. The handler's own try/catch cannot help, because the rejection happens
// outside it.
//
// Worst case now: 6 + 10 + 6 + 10 = 32s of upstream calls, leaving ~18s for the
// candidate queries and the outcome write inside the same 50s wall.
export const SAFETY_TIMEOUT_MS = 10_000;
export const CAPTION_TIMEOUT_MS = 10_000;
// The embedding request needs its own deadline for exactly the same reason. The
// OpenAI SDK path (src/lib/ai/openai.ts) passes no timeout or abort signal, so a
// hung embed would run out the whole remaining budget and be killed by the outer
// wrapper -- outside the handler, where the catch cannot write an outcome.
export const EMBED_TIMEOUT_MS = 6_000;

// ---- trend acquisition ----------------------------------------------------

export const TREND_FETCH_TIMEOUT_MS = 6_000;
// How many feed items to consider. The feed returns ~20; classifying more than
// this buys nothing and costs tokens.
export const MAX_TREND_CANDIDATES = 12;
// Headlines carried into the classifier and the caption prompt per trend. Two is
// enough to disambiguate what a topic is actually about.
export const MAX_HEADLINES_PER_TREND = 3;

// Sum of every bounded upstream deadline in one dispatch. Exported so the test
// suite can assert the headroom against the worker budget rather than trusting
// that someone re-did the arithmetic after editing a constant.
export const UPSTREAM_DEADLINE_BUDGET_MS =
  TREND_FETCH_TIMEOUT_MS + SAFETY_TIMEOUT_MS + EMBED_TIMEOUT_MS + CAPTION_TIMEOUT_MS;
// The worker's per-job timeout for 'x.dispatch'. Duplicated here (not imported)
// because worker.ts owns the queue-wide table and importing it into dispatch
// config would invert the dependency; the test asserts the two agree.
export const WORKER_JOB_TIMEOUT_MS = 50_000;

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

// ---- drift variant --------------------------------------------------------

// Whether a SCHEDULED dispatch may take the drift variant. Off until the variant
// has a contract the model can actually satisfy. Two review rounds and two dry
// runs agree it does not yet:
//
//   run 1 -- two of three drafts obeyed the drift opener and silently dropped the
//            wrong connection; the third overran the character budget.
//   run 2 -- after the opener was tightened, all three produced ONLY the opener:
//            on-topic commentary about the trending term, no specimen, no
//            connection. "Rebranding requires a complete organizational
//            restructuring" addresses the trend directly, which is the one thing
//            rule 1 forbids absolutely and the whole feature exists to prevent.
//
// Left on, a quarter of scheduled dispatches would either fail generation (there
// is no retry, so the day is simply lost) or post commentary on the trend. The
// second outcome is worse than posting nothing, and "no post today" is already
// the designed-for correct result -- so off is the honest setting.
//
// Nothing is deleted: DRIFT_PROBABILITY, driftForDate, DRIFT_DIRECTIVE and the
// dry-run --drift flag all still work, so iterating on the contract needs no code
// change and re-enabling is this one constant. The variant is a term of the tone
// contract; it is not finished, which is different from being unwanted.
export const DRIFT_ENABLED = false;

// ---- live posting ---------------------------------------------------------

// Bounds on the outbound X calls. Neither retries -- a retried post that
// succeeds after a timeout has already posted, which is the one failure this
// feature cannot take back.
export const IMAGE_FETCH_TIMEOUT_MS = 8_000;
export const MEDIA_UPLOAD_TIMEOUT_MS = 12_000;
export const POST_TIMEOUT_MS = 8_000;

// What the posting phase can cost end to end, plus a margin for the outcome
// write that must follow it.
//
// This does NOT fit alongside UPSTREAM_DEADLINE_BUDGET_MS inside the worker's
// 50s, and pretending otherwise would be the dangerous kind of arithmetic: the
// worst case is 32s upstream plus 28s here, and the cron function itself dies at
// 60s (maxDuration), so there is no timeout large enough to make the sum safe.
//
// So the handler does not rely on the sum fitting. It checks the clock before
// starting the post and declines the day if too little time remains -- see
// canStartPostPhase(). A day skipped because the upstream ran slow is cheap; a
// post that lands while the job is being killed, leaving a public post with no
// outcome on the log, is not.
export const POST_WRITE_MARGIN_MS = 3_000;
export const POST_PHASE_BUDGET_MS =
  IMAGE_FETCH_TIMEOUT_MS + MEDIA_UPLOAD_TIMEOUT_MS + POST_TIMEOUT_MS + POST_WRITE_MARGIN_MS;

// True when enough time remains before `deadlineAt` to run the whole posting
// phase AND record the outcome.
//
// The caller must pass the EARLIEST deadline that can stop the work, which is
// not the handler's own timeout: the cron drain runs several jobs sequentially
// inside one 60s function, so a handler that starts 40s in has ~15s left however
// fresh its own clock looks. Measuring against the handler alone would let a
// post start with the invocation nearly spent -- reintroducing, one level up,
// exactly the failure this gate exists to prevent.
export function canStartPostPhase(deadlineAt: number, now = Date.now()): boolean {
  return now + POST_PHASE_BUDGET_MS <= deadlineAt;
}

// What the post phase still needs once the media is uploaded: the create call and
// the outcome write, nothing else.
export const POST_ONLY_BUDGET_MS = POST_TIMEOUT_MS + POST_WRITE_MARGIN_MS;

// The same gate, re-asked after the fetch and upload have already happened.
//
// It has to be a SMALLER requirement than canStartPostPhase, because the two are
// asking different questions. The first is "is there room for all of this?"; the
// second is "is there room for what is left?". Re-asking the first would charge
// the run again for the 20s of fetch and upload it has already spent, so a run
// 20s into a 55s budget would decline with 35s in hand and 11s of work to do --
// refusing viable dispatches in the name of a deadline it was going to meet.
//
// Both directions are wrong here and neither is symmetric: too strict silently
// costs posts, too loose leaves a public post with no outcome row. Charging for
// exactly the remaining work is what keeps both closed.
export function canFinishPostPhase(deadlineAt: number, now = Date.now()): boolean {
  return now + POST_ONLY_BUDGET_MS <= deadlineAt;
}

// X's image ceiling is 5MB. Refuse locally rather than paying for an upload the
// far side will reject.
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;

// Whether an NSFW specimen may be posted LIVE.
//
// The original product call was that the whole corpus is eligible, NSFW
// included, and that still holds for selection and for dry runs. Live posting is
// different, and not because the product decision changed: X API v2 has no
// per-post sensitivity flag. `possibly_sensitive` existed on the v1.1
// statuses/update endpoint and has no equivalent on POST /2/tweets, so there is
// no way to mark an individual post as sensitive at the moment of posting.
//
// That leaves the account-level "mark media as sensitive" setting as the only
// control, which applies to every post or none. Posting unflagged NSFW from an
// account that is not configured that way risks the account itself, which would
// end the feature rather than degrade it. So live mode declines NSFW specimens
// and picks again; dry runs are unaffected.
//
// Set this true ONLY if the posting account has sensitive-media marking enabled
// in its X settings.
export const LIVE_ALLOW_NSFW = false;

// Optional `made_with_ai` labelling on the post. Deliberately tri-state: unset
// asserts nothing, because sending false is as much a claim about the image's
// provenance as sending true, and this code cannot tell how a given specimen was
// made. Set X_DISPATCH_MADE_WITH_AI to "true" or "false" only if that is true of
// the whole corpus.
export function madeWithAiFlag(): boolean | undefined {
  const raw = process.env.X_DISPATCH_MADE_WITH_AI;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

// Whether a specimen may be posted LIVE.
//
// Three conditions, and the NSFW one is subtler than it looks. `isNsfw === false`
// is NOT sufficient: enrichment-persist.ts writes ('manual', false) when the tag
// provider never ran (no key), and nsfwScan.ts documents that state explicitly as
// the key-less default rather than a human safe verdict. Reading it as "safe"
// would let an entirely unclassified image -- which may well be NSFW -- go out
// unflagged, defeating the reason LIVE_ALLOW_NSFW exists. So live posting
// requires a verdict that was actually reached: nsfwSource === 'auto'.
//
// GIFs are excluded because a tweet_gif upload can return a media id while X is
// still processing it asynchronously, and createPost then rejects the not-ready
// media. Polling the processing state is the real fix; excluding them costs
// almost nothing in a stills corpus and cannot post a broken tweet.
export function liveEligible(c: {
  isNsfw: boolean;
  nsfwSource: string | null;
  mime: string | null;
}): boolean {
  if (!LIVE_ALLOW_NSFW) {
    if (c.isNsfw) return false;
    if (c.nsfwSource !== 'auto') return false;
  }
  if ((c.mime ?? '').toLowerCase() === 'image/gif') return false;
  return true;
}
