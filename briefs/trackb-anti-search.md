# Build brief -- Anti-search ("the archive declines your request")

**Status:** approved (owner green-lit). **Depends on:** nothing. **Effort:** S.
**Branch:** `feat/anti-search`. **Ledger assets:** 1 (embedding space) + 3 (canon voice) + 4 (total control).

## Objective

A search that returns the records *farthest* from your query, framed as the institution declining to be
useful and offering its opposite. Plus a single-image "opposite number" (antipode) link that lives
inside normal browsing.

## Concept copy (site register -- no winking, no em dashes)

Landing / empty state:
> The archive has considered your request and declined it. What you asked for, you already carry. Filed
> below instead are the records that stand at the greatest remove from it.

The refusal line should vary (small canned set, optionally clerk-voiced) so the *return* is the draw,
not the gag. Keep every line deadpan and administrative.

## Context (what already exists -- do not rebuild)

- `GET /api/search` (`src/app/api/search/route.ts`): embeds `q` via `getEmbedder(cfg, adminKeys)` (site
  admin keys pay for visitor queries -- intentional), then `searchByVector(vec, { limit, kind:'caption',
  nsfwMode })`, hydrates, returns `{ q, images }`.
- `searchByVector(vec, opts)` (`src/lib/db/queries/embeddings.ts`) **already supports
  `order: 'nearest' | 'farthest'`** (default nearest; `'farthest'` is used today by antibreed). Anti-search
  is a one-flag change to the ranking, not new geometry.
- `/search` page renders the results grid.

## Data model changes

**None.** No tables, no columns, no migration. Pure read path over existing embeddings.

## New / modified code

Two small options -- pick one; recommend (A) for a shareable URL.

**(A) A `mode` param on the existing search route (recommended).**
- `GET /api/search?q=...&mode=decline` -> call `searchByVector(vec, { limit, kind:'caption', nsfwMode,
  order:'farthest' })`; return `{ q, mode:'decline', images, refusal }` where `refusal` is a line picked
  from a small canned array (or one cached LLM line per query-cluster -- see cost note).
- `/search` page: read `mode`; when `decline`, render the refusal header and keep the grid. A visible
  toggle/link ("decline my request") flips the mode; the URL stays shareable.

**(B) A dedicated `/decline` route + `GET /api/decline`** mirroring search. Cleaner separation, one more
file. Functionally identical.

**Single-image antipode (ships with either):** on the detail page, add an "opposite number" link. Given
the image's caption vector (`getCaptionVector(id)`), call `searchByVector(vec, { limit:1, kind:'caption',
nsfwMode, order:'farthest' })` (exclude self) and link to that record with a one-line institutional
caption ("Every record has an opposite it will never be filed near. Yours is on file."). Reuses the same
farthest call at single-image granularity; no new machinery.

## Precompute vs request-time

Request-time and cheap: identical cost to normal search (one query embed + one pgvector scan; `farthest`
is the same `<=>` scan ordered the other way). The refusal lines are canned (free). **Cost note:** if
refusals are LLM-generated for freshness, cache one line per query-cluster or per day -- do NOT call an
LLM per keystroke/request.

## NSFW / gating

Reuse `resolveNsfwMode` exactly as search does; `searchByVector` already honors `nsfwMode`. Farthest
results must be gated identically -- no new surface for hidden rows.

## Verification

- `bun run typecheck && bun run lint && bun run build`.
- `GET /api/search?q=octopus&mode=decline` returns images that are the LOW-similarity tail vs the same
  query without `mode` (spot-check the two result sets are disjoint at the head).
- Antipode link on a detail page resolves to a plausibly-opposite record and never returns self.
- Opted-out-NSFW visitor never receives a hidden row in either mode.

## Risk (from the report, carried forward)

Might be a one-joke feature -- funny once, then ignored. Mitigations already in the plan: vary the
refusals so the returned images (not the bit) are the reward, and wire the single-image antipode so the
mechanic lives inside ordinary browsing, not only on a novelty page.

## Out of scope

No new ranking math, no personalization (that is the separate "archive files on you" idea), no changes
to normal search defaults.
