# Build brief -- Corrections & clarifications (the archive that admits it misfiles)

**Status:** approved (owner green-lit). **Depends on:** the universe layer (already live). **Effort:** S.
**Branch:** `feat/corrections`. **Ledger assets:** 3 (canon) + 1 (geometry gives *real* misfilings) + 4.

## Objective

A standing corrections column in canon. The institution periodically announces that a specimen was filed
into the wrong district, or that an earlier reading was in error, and issues a formal correction --
without quite explaining how the mistake occurred. Most corrections are triggered by a *real* geometric
drift (a specimen whose immutable district-at-intake no longer matches where it now clusters), so they
land as uncanny rather than random.

## Concept copy (site register)

Chronicle entry:
> CORRECTION 0012. The record filed as *the-kelp-auditors-desk* was entered under the drowned-telephone
> district. On review its associations lie with the clock-repair district. The earlier filing stands on
> the record; this correction is appended beside it. No explanation is offered for the original
> assignment.

Keep to the /about voice: the archive never deletes, never fully explains, and treats its own error as
routine administrative fact.

## Context (what already exists -- do not rebuild)

- **Append-only canon:** `events` (`schema.ts:824`), event taxonomy in `src/lib/universe/events.ts`
  (`EVENT_TYPE`, `SUBJECT_TYPE`, `dedupeKey`, payload types), reducers in `src/lib/universe/reduce.ts`,
  rebuild in `materialize.ts`. `audit.flagged` (`AuditFlaggedPayload`) is the precedent: a
  **chronicle/audit artifact that changes NO projection**. Mirror it.
- **Districts from geometry:** `detectCommunities(nodeIds, edges, {pruneK})` in
  `src/lib/universe/cluster.ts` -- deterministic label propagation over the kNN graph. **Important
  subtlety:** district keys are *positional* (`district-${i}`, ordered by smallest member id), so keys
  are NOT stable across recomputes as the corpus grows. Do not compare keys across runs -- match old
  districts to new communities by **member-overlap** (see algorithm).
- `specimens.districtKey` is the immutable district-at-intake (`schema.ts:874`). The correction does NOT
  rewrite it -- immutability is the fiction and the architecture. The correction is the institution
  *noticing* drift, appended beside the original.
- **Read surface:** `/chronicle` + `GET /api/chronicle` -> `loadChronicleEntries(limit, nsfwMode)`
  (`src/lib/universe/chronicle-load.ts`). Evolution loop already runs: `/api/cron/universe` ->
  `universe.tick` (`src/lib/jobs/handlers/universeTick.ts`) -> amend jobs, scored by
  `src/lib/universe/salience.ts`.

## Data model changes

No new tables (corrections are chronicle-only, like audits). Additions to the event taxonomy only:

- `src/lib/universe/events.ts`: add `CorrectionFiled: 'correction.filed'` to `EVENT_TYPE`; a
  `CorrectionFiledPayload = { specimenImageId: number; fromDistrictKey: string; toDistrictKey: string;
  note: string; by: string /* clerk slug */ }`; and `dedupeKey.correction = (imageId, nonce) =>
  `correction.filed:${imageId}:${nonce}`` (nonce = the survey run's seed, same stability reasoning as
  `amendment`/`audit`).
- `src/lib/universe/reduce.ts`: add a `correction.filed` case that is a **no-op on projections** (mirror
  `audit.flagged`) -- optionally append a `lore_fragments` row of `kind='correction'` so it renders in
  the dossier panel and co-embeds like other fragments. Recommend appending the fragment (gives the
  correction a home on the detail page, not only in the chronicle).

## New / modified code

**New correction survey** -- either a `correction.survey` job handler or folded into `universeTick`.
Recommend a small dedicated pass invoked from the existing universe cron so it shares the tick budget:
1. Load current image nodes + `knn_edges` (reuse `listAllImageEdges()`), run `detectCommunities(...)`
   with the SAME `pruneK` the bootstrap used (keep district geometry consistent).
2. Load `districts` (the projection: `key`, `memberImageIds`). Build the old->new mapping by
   **max member overlap**: for each stored district, find the fresh community sharing the most members;
   that pairing defines "the same district, renamed."
3. For each specimen whose `districtKey`'s mapped community no longer contains it (it now sits in a
   different mapped district), it has drifted -> a candidate misfiling.
4. Rate-limit output: file at most N corrections per run (cap, e.g. 1-3) and prefer the largest drifts
   (specimen furthest, by centroid distance, from its intake district). Occasionally (low probability)
   seed a purely fictional correction for texture even when nothing drifted.
5. For each chosen candidate: pick a clerk (reuse the roster selection idiom `img.id % roster.length`),
   generate the correction `note` from the two district characters + the specimen's captions (reuse the
   dossier prompt machinery / a new prompt key `correction`), then append a `correction.filed` event
   (idempotent via `dedupeKey.correction(imageId, nonce)`), and rebuild projections
   (`rebuildProjections()` or the incremental reducer).

**Chronicle rendering:** ensure `loadChronicleEntries` surfaces `correction.filed` entries (add a case
+ an entry shape); render a "corrections" style on `/chronicle` and, if the fragment is appended, in
`dossier-panel.tsx` / `amendment-history.tsx`.

## Precompute vs request-time

Nightly (or per universe tick), offline: community recompute is pure vector-graph math (free); one LLM
call per filed correction (rare -- capped per run). Reading corrections in `/chronicle` is a cheap event
scan. **Cost note:** bounded LLM calls only; no per-request model calls.

## Register / integrity guardrails

- Append-only: never UPDATE/DELETE an event or rewrite `specimens.districtKey`. The correction sits
  *beside* the original filing.
- Determinism: `detectCommunities` is deterministic for fixed nodes+edges+opts, so a correction reflects
  a real change in the graph (new images/edges), not RNG. Verify by re-running with an unchanged graph
  and asserting zero new corrections.

## Verification

- `bun run typecheck && bun run lint && bun run build`.
- Run the survey against the current corpus with an unchanged kNN graph -> zero real corrections
  (only the rare seeded-fictional one, if enabled).
- Add/rewire edges so one specimen's community membership changes, re-run -> exactly one
  `correction.filed` event for it, idempotent on re-run (dedupe_key holds).
- `GET /api/chronicle` returns the correction entry, NSFW-gated identically to specimen entries.
- `bun scripts/universe-rebuild.ts` replays the log including corrections with zero API calls and stable
  projection counts (extend `verify-universe.ts` if it asserts event/type counts).

## Risk (carried forward)

Too frequent -> noise; too rare -> nobody notices the column. Mitigation is in the algorithm: cap per
run and let real geometric drift trigger most corrections so they read as uncanny, not random. Overlaps
thematically with progressive-redaction (a benched runner-up) -- keep corrections about *filing/district*
error specifically so the two would not collide if redaction is later built.

## Out of scope

No re-filing of `districtKey`, no visitor-submitted corrections (no UGC), no district *renaming*
ceremony (a separate benched idea). Corrections only *notice* drift; they never act on it.
