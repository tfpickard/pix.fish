// Event taxonomy for the universe canon. The `events` table stores these as
// rows; the reducers in reduce.ts fold them into projections. Phase 1 emits
// the first four types. The rest are reserved for the Phase 2 evolution loop
// (autonomous amendments, contradiction audits, geodesic walks) -- listed here
// so the model is explicit and not foreclosed, but NOT emitted yet.

export const EVENT_TYPE = {
  ClerkCommissioned: 'clerk.commissioned',
  DistrictIntake: 'district.intake',
  SpecimenIntake: 'specimen.intake',
  CrossReferenceFiled: 'cross_reference.filed',
  // Phase 2:
  DossierAmendment: 'dossier.amendment',
  AuditFlagged: 'audit.flagged',
  // Phase 3: a clustering run that identifies the recurring characters. One
  // event carries the whole roster; the newest census wins in the projection.
  CharacterCensus: 'character.census',
  // Outbound X dispatch. Three types for one daily run: the claim (which IS the
  // once-per-day lock -- see dedupeKey.dispatchDay), and exactly one outcome,
  // either sent or skipped. Every day the job runs leaves a claim plus an
  // outcome, so the log answers "what did the account do on the 4th" directly.
  // None of these are reduced into a projection and none are in the chronicle's
  // type allow-list: surfacing them in the feed is deliberately out of scope.
  DispatchClaimed: 'dispatch.claimed',
  // Written immediately BEFORE the X call, live runs only. Its whole job is to
  // burn the specimen durably ahead of the side effect: if the post succeeds and
  // the dispatch.sent write then fails, this row is what stops the same specimen
  // going out again on a later day.
  DispatchAttempted: 'dispatch.attempted',
  DispatchSent: 'dispatch.sent',
  DispatchSkipped: 'dispatch.skipped',
  // An admin signed off on a specific draft. Written before the publish job does
  // anything, and deduped on the draft, so one draft can be approved once.
  DispatchApproved: 'dispatch.approved'
} as const;

export type EventType = (typeof EVENT_TYPE)[keyof typeof EVENT_TYPE];

// The dispatch slice of the taxonomy, for queries that read the whole outbound
// history at once (/admin/dispatch).
export const DISPATCH_EVENT_TYPES = [
  EVENT_TYPE.DispatchClaimed,
  EVENT_TYPE.DispatchAttempted,
  EVENT_TYPE.DispatchSent,
  EVENT_TYPE.DispatchSkipped
] as const;

export const SUBJECT_TYPE = {
  Clerk: 'clerk',
  District: 'district',
  Specimen: 'specimen',
  CrossReference: 'cross_reference',
  Census: 'census',
  Dispatch: 'dispatch'
} as const;

// ---- payload shapes (the jsonb body of each event) ------------------------

export type ClerkCommissionedPayload = {
  name: string;
  department: string;
  voice: string;
  agenda: string;
};

export type DistrictIntakePayload = {
  name: string;
  character: string;
  memberImageIds: number[];
  size: number;
};

// The specimen intake carries the dossier text AND its embedding vector. The
// vector lives in the canon so a projection rebuild can re-populate the
// embeddings table offline, with zero API calls -- the dossier was embedded
// once at intake and that is part of the filed record.
export type SpecimenIntakePayload = {
  dossier: string;
  districtKey: string;
  embedding: number[] | null;
  embedProvider: string | null;
  embedModel: string | null;
};

export type CrossReferenceFiledPayload = {
  srcImageId: number;
  dstImageId: number;
  dist: number;
};

// A dossier amendment (Phase 2). Same shape as an intake -- a clerk files new
// dossier text + its embedding -- but it appends to the record rather than
// founding it. The reducer advances the specimen's current dossier and bumps
// its generation; prior fragments are never overwritten.
export type DossierAmendmentPayload = {
  dossier: string;
  districtKey: string;
  embedding: number[] | null;
  embedProvider: string | null;
  embedModel: string | null;
};

// A flagged contradiction (Phase 2). Purely a chronicle/audit artifact: it
// records that one clerk's filing contradicts another's. It changes no
// projection -- the contradiction itself lives in the dossier fragments, which
// are never reconciled.
export type AuditFlaggedPayload = {
  note: string;
  by: string; // clerk slug who flagged / introduced the contradiction
  contradicts: string | null; // clerk slug being contradicted, if known
};

// The full recurring-character roster from one clustering run (Phase 3). The
// newest census defines the current characters; the reducer clears + replaces
// the projection from it. Self-contained (crop urls embedded) so a rebuild
// needs no crops table.
export type CharacterCensusPayload = {
  characters: {
    key: string;
    name: string;
    dossier: string;
    clerkSlug: string;
    canonicalCropUrl: string | null;
    appearances: {
      imageId: number;
      cropUrl: string | null;
      box: { left: number; top: number; width: number; height: number } | null;
    }[];
  }[];
};

// ---- outbound dispatch payloads -------------------------------------------

// The day-claim. Carries nothing but the mode it intended to run in; its value
// is entirely in its dedupe key, which is what makes a second dispatch on the
// same date impossible rather than merely unlikely.
export type DispatchClaimedPayload = {
  mode: 'dry-run' | 'live';
  trigger: 'cron' | 'manual';
};

// The specimen a live run is about to post, recorded before the call so the
// commitment survives a failure of the outcome write.
export type DispatchAttemptedPayload = {
  // Which claim slot this belongs to. subjectId is only the UTC date, and manual
  // runs are unlimited, so a single date can carry many independent runs -- an
  // attempt can only be paired with ITS outcome by the slot. Correlating on the
  // date instead lets an unrelated run's outcome vouch for an attempt that never
  // completed, which is the one thing this event exists to make visible.
  slotKey: string;
  trigger: 'cron' | 'manual';
  imageId: number;
  slug: string;
};

// A dispatch that produced a post (live) or a complete would-be post (dry run).
// Everything needed to review the decision after the fact is on the event: the
// specimen, the caption as posted, the trend it rode, and the safety verdict
// that cleared it.
// Recorded when an admin approves a draft for publication. Separate from the
// publication itself: the approval is a human decision and survives even if the
// post then fails, which is what makes the log answer "was this signed off?"
// independently of "did it go out?".
export type DispatchApprovedPayload = {
  draftEventId: number;
  slotKey: string;
  imageId: number;
  slug: string;
};

export type DispatchSentPayload = {
  // Pairs this outcome with its dispatch.attempted. See the note there.
  slotKey: string;
  mode: 'dry-run' | 'live';
  // How this outcome came about. The claim event already records it, but nothing
  // associates a claim with its outcome at read time -- /admin/dispatch lists
  // outcomes and would otherwise show an admin's review sample and the day's real
  // artifact as two indistinguishable drafts for the same date.
  trigger: 'cron' | 'manual';
  imageId: number;
  slug: string;
  handle: string;
  blobUrl: string;
  isNsfw: boolean;
  caption: string;
  hashtags: string[];
  drift: boolean;
  trendTopic: string;
  trendSource: string;
  trendHeadlines: string[];
  safetyCategory: string;
  safetyConfidence: string;
  safetyReason: string;
  distance: number;
  model: string;
  postId: string | null; // null in dry run
  // Permalink to the live post. Derived from postId, but stored rather than
  // rebuilt at read time: the URL shape is X's to change, and the log is meant
  // to stay resolvable without this codebase being around to reconstruct it.
  postUrl?: string | null;
};

// A day that ended without a post. `reason` is one of the SKIP_REASON codes in
// src/lib/dispatch/types.ts; `detail` is free text for the admin page.
export type DispatchSkippedPayload = {
  // Pairs this outcome with its dispatch.attempted. A post_indeterminate skip is
  // an outcome for an attempt just as much as a sent is.
  slotKey: string;
  // Set only on the approval-publication path: which draft this attempt was
  // publishing. Counting these is how a definitely-failed publication releases
  // its approval for a retry.
  draftEventId?: number;
  mode: 'dry-run' | 'live';
  trigger: 'cron' | 'manual';
  reason: string;
  detail: string;
  trendTopic: string | null;
};

// A cited source: where a clerk says a claim came from. Kept loose (a free
// label plus an optional ref) so clerks can cite captions, neighbors,
// districts, or other dossiers without a rigid schema.
export type Citation = {
  kind: 'caption' | 'neighbor' | 'district' | 'dossier' | string;
  ref: string;
  note?: string;
};

// ---- dedupe keys (idempotency guards) -------------------------------------
// One stable key per logical fact. The events table's unique index on
// dedupe_key makes re-filing a no-op, which is the whole basis for bootstrap
// idempotency on an append-only log.

export const dedupeKey = {
  clerk: (slug: string) => `clerk.commissioned:${slug}`,
  district: (key: string) => `district.intake:${key}`,
  specimenIntake: (imageId: number) => `specimen.intake:${imageId}`,
  crossReference: (srcImageId: number, dstImageId: number) =>
    `cross_reference.filed:${srcImageId}:${dstImageId}`,
  // Amendments are keyed by a stable per-job nonce (the amend job's seed), NOT
  // by live specimen generation. Deriving the key from generation made it
  // unstable across retries (a retry that reloaded an advanced specimen would
  // compute a new key and file a duplicate) and across races (the loser would
  // replay and bump generation again). A fixed nonce means all attempts of one
  // amend job collapse to a single canon event, while distinct ticks (distinct
  // seeds) still produce distinct amendments.
  amendment: (imageId: number, nonce: number) => `dossier.amendment:${imageId}:${nonce}`,
  audit: (imageId: number, nonce: number) => `audit.flagged:${imageId}:${nonce}`,
  // Each census run gets a unique stamp so re-clustering files a NEW census
  // (the newest wins) rather than colliding with a prior one.
  census: (stamp: number) => `character.census:${stamp}`,
  // THE once-per-day cap for outbound dispatch. The unique index on dedupe_key
  // is the enforcement: whoever inserts this key first owns the day, and every
  // other caller -- a double-fired cron, a manual POST, a job reclaimed after a
  // timeout -- gets inserted=false from appendEvent and stops. The guarantee
  // therefore does not depend on the cron schedule being correct.
  //
  // `suffix` exists so an admin review run can claim a distinct slot ('manual:
  // <ms>') without consuming the real day's claim. A suffixed claim can never
  // collide with the bare date key.
  dispatchDay: (dateKey: string, suffix?: string) =>
    suffix ? `x.dispatch:${dateKey}:${suffix}` : `x.dispatch:${dateKey}`,
  // Outcomes are keyed off the same slot id so one claim yields at most one
  // outcome even if a handler somehow ran twice against the same claim.
  dispatchOutcome: (slotKey: string) => `x.dispatch.outcome:${slotKey}`,
  // The pre-post attempt marker, keyed off the SPECIMEN rather than the slot.
  //
  // This is mutual exclusion, and it has to be, because nothing upstream of it
  // is. The enqueue guards are check-then-act; per-slot seeding only makes two
  // concurrent runs UNLIKELY to draw the same image, and with a single eligible
  // candidate it does not even do that -- both seeds necessarily pick the one
  // row. The unique index on dedupe_key is the only real lock available, so the
  // attempt marker is where the specimen gets claimed: whoever inserts first
  // posts, and any concurrent run gets inserted=false and stops before its own
  // side effect.
  //
  // `generation` is what keeps that lock from being permanent. Keying on the
  // image alone would retire a specimen forever on its first attempt, defeating
  // the rule that a DEFINITE rejection (a readable 4xx, nothing published)
  // releases it -- a 403 from a read-only token would otherwise consume one good
  // specimen per run with nothing to show. Generation is the count of definite
  // failures this image has already recorded, so a released specimen gets a
  // fresh key while two concurrent runs, computing the same count, still collide
  // on the same one.
  dispatchAttempt: (imageId: number, generation: number) =>
    `x.dispatch.attempt:${imageId}:${generation}`,
  // One approval per draft. The publish job's first act, so a double-clicked
  // button, a re-enqueued job, or two admins looking at the same page collapse
  // to a single publication of that draft.
  // `generation` counts publish attempts for this draft that ended definitely --
  // nothing published. Without it a single pre-post failure (a stale credential,
  // a blob 404, a spent budget) made approval permanent: the claim was already
  // committed, so every later click enqueued a job that returned immediately and
  // the draft could never be published by anyone. Same shape as the specimen
  // lock, same reason: the lock must survive a success and yield to a definite
  // failure.
  dispatchApproval: (draftEventId: number, generation: number) =>
    `x.dispatch.approve:${draftEventId}:${generation}`
};
