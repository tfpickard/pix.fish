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
  CharacterCensus: 'character.census'
} as const;

export type EventType = (typeof EVENT_TYPE)[keyof typeof EVENT_TYPE];

export const SUBJECT_TYPE = {
  Clerk: 'clerk',
  District: 'district',
  Specimen: 'specimen',
  CrossReference: 'cross_reference',
  Census: 'census'
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
  census: (stamp: number) => `character.census:${stamp}`
};
