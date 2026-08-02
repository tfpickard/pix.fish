// Shared shapes for the outbound X dispatch pipeline. Kept infra-free so the
// pure stages (schedule jitter, safety pre-filter, band selection, caption
// validation) can be unit tested without a DB or a provider.

// One candidate trending topic plus enough surrounding context to know what it
// is actually about. `headlines` is what the safety gate reasons over -- a bare
// topic string ("Jaguar") cannot be classified safely.
export type Trend = {
  topic: string;
  // Free label for where this came from, persisted on the event for provenance.
  source: string;
  headlines: { title: string; source: string | null }[];
  // Rough popularity if the source reports it (Google Trends' approx_traffic).
  approxTraffic: string | null;
};

// Why a candidate was rejected, or accepted. `category` is only meaningful when
// `safe` is true; the caption prompt never sees it, it exists for the event log
// and for the "prefer inherently dumb trends" ranking.
export type SafetyVerdict = {
  // Index into the exact array submitted to the classifier. The binding must
  // survive all the way to selection: matching a verdict back to its trend by
  // topic string silently rebinds when the feed carries two entries with the
  // same title and different coverage, which could clear a candidate the
  // classifier actually rejected.
  index: number;
  topic: string;
  safe: boolean;
  category: string;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
};

export type ClassifiedTrend = { trend: Trend; verdict: SafetyVerdict };

// A specimen eligible for dispatch: an image with a caption embedding, its
// intake record (the clerk's dossier when one exists, else its canonical
// caption), and the cosine distance from the trend text that put it in the band.
export type SpecimenCandidate = {
  imageId: number;
  slug: string;
  handle: string;
  blobUrl: string;
  mime: string | null;
  isNsfw: boolean;
  // How isNsfw came to be what it is. Load-bearing for live posting: 'auto'
  // means the tag pass actually ran and reached a verdict, whereas
  // ('manual', false) is the KEY-LESS DEFAULT, not a human saying it is safe --
  // see the comment in jobs/handlers/nsfwScan.ts. Treating that default as a
  // safe verdict would let an unclassified image post unflagged.
  nsfwSource: string | null;
  uploadedAt: Date;
  intakeRecord: string;
  distance: number;
};

// Every way a day can end without a post. Recorded verbatim on the
// dispatch.skipped event so the admin page can group them.
export const SKIP_REASON = {
  AlreadyDispatched: 'already_dispatched',
  NoTrends: 'no_trends',
  NoSafeTrend: 'no_safe_trend',
  ClassifierError: 'classifier_error',
  NoSpecimen: 'no_specimen',
  NoProviderKey: 'no_provider_key',
  GenerationFailed: 'generation_failed',
  PostFailed: 'post_failed',
  // The request reached X and no usable answer came back -- a timeout, an abort,
  // a 2xx whose body could not be read. The post MAY be public. Distinct from
  // post_failed on purpose: the admin page renders a skip as "no post", and
  // saying that about a day whose post may exist is the audit surface asserting
  // something it does not know. An operator seeing this should check the account.
  PostIndeterminate: 'post_indeterminate',
  // X read the request and refused the ARTIFACT itself -- a 400, which for
  // POST /2/tweets means this exact payload is not acceptable (a caption past
  // the account's length limit is the likely one). Nothing was published, same
  // as post_failed, but the difference is what a retry would do: post_failed is
  // about the environment (a stale credential, a throttle, a spent budget) and
  // re-approving after fixing it can succeed, whereas this is about bytes that
  // are immutable by design -- the whole point of approval is that the caption
  // posted is the caption read. So the draft is retired and the button
  // withdrawn, instead of leaving an operator to click it until they conclude
  // the feature is broken. The SPECIMEN is untouched: it never reached X, and a
  // fresh draft over the same image is exactly the right next step.
  //
  // Only the approval path can produce this. A scheduled run has no draft --
  // its caption is generated in the run and the next day generates another --
  // so a 400 there is an ordinary post_failed.
  DraftRejected: 'draft_rejected',
  // A run was queued as an explicit live request but was no longer live-capable
  // by the time it drained -- the switch was turned off, or credentials rotated,
  // in the gap between the admin endpoint accepting it and the queue running it.
  // Its own outcome rather than a silent dry run: the POST already told the
  // operator a LIVE job was queued, so quietly filing a draft would leave them
  // believing a post went out. Everywhere else "not configured" degrades to dry,
  // which is right when nothing asked to post; here something did.
  LiveUnavailable: 'live_unavailable',
  // Backstop for an unexpected throw anywhere after the day has been claimed --
  // a transient DB read, a missing OWNER_GITHUB_ID, a provider that cannot
  // embed. Without it the day would stay claimed with no outcome on the log and
  // the cron would decline to re-enqueue, producing a silent no-post day. Every
  // day the job starts must end with an outcome, so unexpected failures get a
  // reason code too.
  InternalError: 'internal_error'
} as const;

export type SkipReason = (typeof SKIP_REASON)[keyof typeof SKIP_REASON];

// The outcomes that PROVE nothing became public: X read the request and refused
// it. Everything else -- post_indeterminate above all -- leaves open that a post
// exists, and the guards that consume this set stay conservative about those.
//
// One constant rather than four inline `= 'post_failed'` comparisons, because
// four copies of a predicate is how they come to disagree: adding draft_rejected
// would otherwise have had to be remembered in listDispatchedImageIds,
// publiclyPostedImageIds, livePostAttemptedOnDate and definiteFailureGeneration
// separately, and the last round of review was about exactly that class of
// divergence.
//
// publishAttemptGeneration deliberately does NOT use this set -- see the note
// there. A definite rejection frees the SPECIMEN; only some of them free the
// DRAFT.
export const DEFINITE_FAILURE_REASONS = [
  SKIP_REASON.PostFailed,
  SKIP_REASON.DraftRejected
] as const;

// The assembled would-be post. In dry run this is the whole deliverable: it is
// written to the event log and rendered at /admin/dispatch for review. In live
// mode the same object is what gets posted.
export type DispatchDraft = {
  imageId: number;
  slug: string;
  handle: string;
  blobUrl: string;
  isNsfw: boolean;
  caption: string;
  hashtags: string[];
  drift: boolean;
  trend: Trend;
  verdict: SafetyVerdict;
  distance: number;
  model: string;
};
