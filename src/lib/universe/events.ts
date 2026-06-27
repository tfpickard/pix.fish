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
  // Reserved (Phase 2):
  DossierAmendment: 'dossier.amendment',
  AuditFlagged: 'audit.flagged'
} as const;

export type EventType = (typeof EVENT_TYPE)[keyof typeof EVENT_TYPE];

export const SUBJECT_TYPE = {
  Clerk: 'clerk',
  District: 'district',
  Specimen: 'specimen',
  CrossReference: 'cross_reference'
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
  // Amendments are keyed by the generation they produce, so two concurrent
  // ticks racing on the same specimen can only ever file one amendment for a
  // given generation -- the second is absorbed by the unique index.
  amendment: (imageId: number, generation: number) =>
    `dossier.amendment:${imageId}:${generation}`,
  audit: (imageId: number, generation: number) => `audit.flagged:${imageId}:${generation}`
};
