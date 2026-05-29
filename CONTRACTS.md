# CONTRACTS.md (Gate-0 frozen interfaces)

The six parallel-build features run in separate worktrees off post-Gate-0
master and integrate at per-feature gates. To make that collision-free, all
additive schema, the sort-enum member, the job-type keys, the image-generation
interface, and the model assignments are FROZEN here at Gate 0. After Gate 0 no
feature edits `src/lib/db/schema.ts` or `drizzle/` numbering; each feature only
adds new files (query helpers, handlers, routes, components) plus calls to the
shared `scripts/ensure-features.ts`. The human runs `bun run db:generate` once
at integration to emit the consolidated numbered migration.

See ARCHITECTURE.md for how the existing seams work.

## Branch / model map

| Branch | Feature | Agent / model | Depends on |
|---|---|---|---|
| feat/hud | Entropy HUD + surprising-first + NSFW scan | mixed (entropy core Opus, plumbing Sonnet) | embeddings (exists) |
| feat/manifold | 3D point cloud | Sonnet | embeddings (exists) |
| feat/geodesics | kNN graph + geodesic paths | Sonnet | embeddings; 3D overlay soft-needs manifold |
| feat/stigmergy | Attention decay + drift bias | Opus (math), Sonnet (telemetry) | drift() seam (exists) |
| feat/alive | Reproduction / archive | Opus (math/safety), Sonnet (adapter/UI) | **stigmergy merged** (fitness) |
| feat/basement | Hidden server-gated gallery | Sonnet | none |

Default Sonnet 4.6; Opus 4.8 only by justified exception (math correctness,
safety-critical reversibility, contract design). Full task-level table lives in
the plan file (`~/.claude/plans/...mossy-anchor.md`).

## Frozen schema (in `schema.ts`, applied by `scripts/ensure-features.ts`)

New columns on `images` (all nullable / defaulted, dormant until their phase):
- `surprisal: real | null` -- feat/hud. 0..1 normalized. null = unscored.
- `generation: integer = 0` -- feat/alive. 0 = not bred.
- `archivedAt: timestamptz | null` -- feat/alive. set = hidden, recoverable.
- `basement: boolean = false` -- feat/basement. server-gated like NSFW.

New tables (exported types: `CollectionTemperature`, `ManifoldProjection`, `KnnEdge`, `ImageAttention`):
- `collection_temperature(id, value real, pointCount int, meta jsonb, computedAt)` -- feat/hud time series.
- `manifold_projections(id, seed int, points jsonb [{imageId,x,y,z}], pointCount int, params jsonb, createdAt)` -- feat/manifold.
- `knn_edges(id, srcId fk, dstId fk, dist real, createdAt)`, index on srcId, unique (srcId,dstId) -- feat/geodesics.
- `image_attention(imageId pk fk, value real = 0, lastUpdatedAt timestamptz)` -- feat/stigmergy.

Reused (do NOT duplicate): `image_lineage` (child->parent edges) for feat/alive parentage; `embeddings` for all vector reads; `umap_projections` as the 2D sibling of `manifold_projections`.

## Sort contract

`'surprising-first'` is already in `SortMode` + `SORT_META` (`src/lib/sort/types.ts`,
group `weird`, `needsEmbeddings:false`) and dispatched in `images.ts`
`fetchInSortOrder` as `ORDER BY surprisal DESC NULLS LAST`. feat/hud only needs
to populate `images.surprisal`; the sort already works (unscored rows sort last).

## Job-type keys (reserved in `handlers/index.ts`)

Register the handler before enqueuing (an unregistered type fails the job):
- `nsfw.scan` -- feat/hud. Payload `{ imageId }`. Calls a Haiku-pinned nudity
  classifier (prompt key `nsfw`, seeded) and updates ONLY `images.isNsfw` when
  `nsfwSource != 'manual'`; tags/captions untouched. Build the classifier inside
  `src/lib/ai/` (Anthropic provider pinned to `claude-haiku-4-5`); parse with the
  existing `parseTagsJson` (reads `nsfw`, empty `tags` is fine). Admin trigger
  modeled on `/admin/reprocess` (scope `all` | `imageIds[]`).
- `entropy.recompute` -- feat/hud. Recompute surprisal + collection temperature; enqueue after upload, report temperature delta.
- `manifold.recompute` -- feat/manifold. 3D umap projection -> `manifold_projections`.
- `knn.rebuild` -- feat/geodesics. kNN over `allCaptionVectors()` -> `knn_edges`.

feat/stigmergy (telemetry ingest + read-time decay) and feat/alive
(admin-triggered reproduction) add routes, not job types.

## Image generation contract (`src/lib/ai/imagegen.ts`)

```
interface ImageGenerator { name; model; generate(req): Promise<ImageGenResult> }
ImageGenRequest  = { prompt: string; width?; height?; seed? }   // prompt: no em dashes
ImageGenResult   = { bytes: Buffer; mime: string; provider; model } // bytes -> Blob put()
getImageGenerator(): ImageGenerator   // returns StubImageGenerator (1x1 PNG) until owner wires a real adapter
```
feat/alive builds the pipeline against this; dry-run never calls `generate()`.
OWNER TODO: wire a real text-to-image adapter + key inside `src/lib/ai/`.

## Read helpers leaf features build on (already exist)

- Embeddings: `allCaptionVectors()`, `getCaptionVector(id)`, `searchByVector(vec,opts)`, `upsertEmbedding(...)` (`src/lib/db/queries/embeddings.ts`).
- Image lists/sort: `listImages(...)`, `fetchInSortOrder(...)`, `selectImagesOrdered(...)` (`src/lib/db/queries/images.ts`).
- Batch selection: `allImageIds()`, `staleImageIds(...)` (`src/lib/db/queries/reprocess.ts`).
- Queue: `enqueueJob({type,payload,maxAttempts?,runAt?})`, `jobsOverview(n)` (`src/lib/db/queries/jobs.ts`).
- Auth gates: `isSiteAdmin(session)`, `canEdit(session, ownerId)` (`src/lib/auth.ts`).
- Drift to bias: `drift()` in `src/lib/sort/reorder.ts` (feat/stigmergy only).

## Conventions (enforced)

- No em dashes; use `--`. Comments say why, not what.
- New admin endpoints add an explicit in-handler `isSiteAdmin`/`canEdit` gate.
- No AI SDK calls outside `src/lib/ai/`; prompts come from the DB.
- One feature = one branch = one gate commit = one PR. Stop at each gate for review.
- Verify each branch: `bun install && bun run typecheck && bun run lint && bun run build`.
