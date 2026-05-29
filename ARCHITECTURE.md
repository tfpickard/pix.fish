# ARCHITECTURE.md

Recon map of pix.fish as it actually exists today, written so the six
parallel-build features land on fact rather than the original brief's
assumptions. The brief imagined a simple single-owner gallery; the real app is
multi-user with async enrichment, pgvector embeddings, a 2D UMAP atlas, a
job queue, and an embedding-math "breed" tool. Where the brief and the code
disagree, the code wins. CLAUDE.md is the authoritative deep reference; this
file is the feature-build orientation.

## Stack (verified)

- **Framework:** Next.js 14.2 App Router, React 18, TypeScript (strict).
- **Package manager:** bun (`bun.lock` authoritative). Scripts: `bun run dev|build|lint|typecheck|db:generate|db:push|db:seed`.
- **Hosting:** Vercel. Node.js runtime for API routes (`export const runtime = 'nodejs'`), `force-dynamic` on data routes. Cron drives the job queue (`vercel.json`).
- **DB:** Drizzle ORM on `@vercel/postgres` (Neon). Schema `src/lib/db/schema.ts`; migrations `drizzle/0000..0003`; `drizzle.config.ts` reads `POSTGRES_URL`. pgvector enabled in `drizzle/0000_init.sql` (+ idempotent `scripts/ensure-pgvector.ts`).
- **Blob:** Vercel Blob for image bytes (`BLOB_READ_WRITE_TOKEN`).
- **No `sharp` / native image libs.** EXIF via `exifr`, palette via `node-vibrant`. `images.width/height` stay null.
- **Offline compute is bun**, not Python. New batch jobs are either `bun scripts/<name>.ts` or job-queue handlers. There is no Python toolchain and none is being added.

> Local-env note: `node_modules` must be in sync with `package.json` (`bun install`). The build pulls `d3` (used by `src/components/lineage-graph.tsx`); a stale install fails with "Can't resolve 'd3'".

## Data model (image-centric)

`images` (`schema.ts`) is the hub. Per-image children cascade on delete:
`captions`, `descriptions`, `tags`, `embeddings`, `reactions`, `comments`,
`reports`, `collection_items`, `image_lineage`. Identity in `users`;
per-resource ownership via `images.ownerId`.

- **Slugs are unique per owner** (`images_owner_slug_uniq`). Canonical detail URL `/u/<handle>/<slug>`; legacy bare `/<slug>` redirects. `slug_history` (GIN) resolves renamed URLs.
- **Captions/descriptions:** 3 AI variants per field (one JSON call returns all three); a manual caption is variant 4 (`locked`, `isSlugSource`). Random variant selection is server-side per request.
- **Tags:** `(image_id, tag)` unique; `source` is `taxonomy|freeform`. The tag pass also returns an NSFW verdict (`TagsAndNsfw`).
- **NSFW:** `images.isNsfw` + `nsfwSource` (`auto|manual`); manual never clobbered by an auto pass. Gating is server-side at the query layer (the `pf_show_nsfw` cookie opts in; blob URL never shipped to opted-out visitors). GPS EXIF is stripped before persist.
- **Lineage already exists:** `image_lineage` (child->parent edges, `promptUsed`/`dialectUsed`) backs the `/lineage` force-graph (`src/components/lineage-graph.tsx`). feat/alive reuses this for parentage.

## Embedding access path (the seam Phases 1-3 and 5 reuse)

- Table `embeddings`: `vector(1536)`, `kind in ('image','caption','combined')`, **only `'caption'` written today**, `UNIQUE(image_id, kind)`.
- Read/write helpers: `src/lib/db/queries/embeddings.ts`
  - `getCaptionVector(imageId): number[] | null`
  - `allCaptionVectors(): { imageId, vec: number[] }[]`  <- the corpus read for offline passes
  - `searchByVector(vec, opts)` (nearest / farthest by cosine)
  - `upsertEmbedding({ imageId, kind, vec, provider, model })` (validates 1536-dim, finite)
- pgvector returns vectors as bracketed text; helpers parse to `number[]`. Cosine math (`drift`, `breed`) operates on plain arrays in app code.
- Backfill pattern: `scripts/backfill-embeddings.ts` (read unembedded -> per-owner embedder -> `upsertEmbedding`). The provider/embedder is resolved per owner from encrypted BYO keys with env-var fallback.

## Sort modes (the seam Phases 1, 4, 5 plug into)

- Registry: `src/lib/sort/types.ts` -- `SortMode` union + `SORT_META` record (`label`, `description`, `group`, `randomSeeded`, `needsEmbeddings`). `DEFAULT_SORT='drifting'`. UI reads `SORT_META`.
- Dispatch: `src/lib/db/queries/images.ts` `fetchInSortOrder()`:
  - **SQL-native** (`ORDER BY`): newest, oldest, memory-lane, chronograph, lonely, and now `surprising-first`.
  - **In-memory reorder** of the top `CANDIDATE_CAP=300` rows, with a base-order tail stitched on for pagination: random, rainbow, tidal, plus the embedding-driven drift/ancient-drift/clumped/anti-clumped/drunkards-walk (algorithms in `src/lib/sort/reorder.ts`).
- `drift()` (reorder.ts) is MMR over caption embeddings (recency vs dispersion, alpha=0.65). **feat/stigmergy biases this function**; all other sorts stay unbiased.
- Defaults: `gallery_config` (per-owner key/value) holds `default_sort`; read by `/api/images` GET when no `sort` param (`getGalleryDefaults`).

## Upload + enrichment (async)

`POST /api/images` (any signed-in user): upload to Blob -> extract EXIF+palette
(`src/lib/image-meta.ts`, GPS stripped) -> insert row with placeholder slug ->
**enqueue `enrich.image`** -> return `202 {status:'queued'}`. The UI polls
`GET /api/images?ids=...`. The model never runs inline.

Enrichment core: `src/lib/enrichment.ts` (3 parallel field calls, skip any field
with no key) + `src/lib/enrichment-persist.ts` (variants, slug, embedding
best-effort after commit). NSFW verdict resolved here.

## Job queue (the seam new batch work plugs into)

- Table `jobs`: leased with a visibility timeout (`lockedAt`), not `FOR UPDATE`.
- Drain: `/api/cron/jobs` (GET=cron, POST=manual), `Authorization: Bearer ${CRON_SECRET}`. Reclaims stuck `processing` rows (>5 min), then claims/runs batches of 10 until a 55s wall budget.
- Worker: `src/lib/jobs/worker.ts` dispatches by `job.type` via `handlers/index.ts`, per-type timeout (`JOB_TIMEOUT_MS`), exponential backoff to `maxAttempts` then `failed`.
- Handlers: `src/lib/jobs/handlers/` (`enrichImage`, `reprocessImage`, `umapRecompute`, `webhookDeliver`, `backupExport`). Add a type: write `handlers/X.ts`, register in `handlers/index.ts`, add a timeout in `worker.ts`, enqueue via `enqueueJob` (`src/lib/db/queries/jobs.ts`).
- **Batch model to copy:** `/admin/reprocess` + `/api/admin/reprocess` + `reprocessImage` handler + `src/lib/db/queries/reprocess.ts` (`allImageIds`, `staleImageIds`). Running `fields:['tags']` reruns the NSFW verdict and updates `images.isNsfw` when `nsfwSource != 'manual'`. Monitor at `/admin/jobs` (`jobsOverview`, 5s auto-refresh).

## UMAP atlas (what feat/manifold extends)

2D already ships: `umap_projections` (points `[{imageId,x,y}]`), computed by
`umap-js` in `src/lib/jobs/handlers/umapRecompute.ts` (subsamples >5000 to fit
60s), read via `src/lib/db/queries/umap.ts`, rendered on a 2D `<canvas>`
(`src/components/umap-canvas.tsx`) at `/map` (+ `/admin/map` recompute button,
`umap.recompute` job). **No three.js / r3f yet** -- feat/manifold adds them for 3D.

## Breed tool (what feat/alive reuses)

`src/lib/ai/breed.ts`: vector math over caption embeddings (centroid /
interpolation / farthest-seeded / anchor-minus-others) then LLM render. Four
modes (breed/depart/antibreed/subtract). Needs >=2 embedded sources. feat/alive
reuses this interpolation math for child target embeddings.

## AI provider abstraction

All vision/embedding calls go through `AIProvider` (`src/lib/ai/types.ts`) via
`getProvider(field,cfg,keys)` / `getEmbedder(cfg,keys)` (`src/lib/ai/index.ts`).
Prompts come from the DB (`src/lib/prompts/resolve.ts`), never hardcoded in a
provider. Per-field routing is DB-driven (`ai_config` + `loadConfig.ts`). Keys
are per-user BYO, AES-GCM encrypted (`keys.ts`), with env-var fallback. Factories
return `null` when no usable key; callers skip that field. **No SDK calls outside
`src/lib/ai/`.** Image generation (feat/alive) is the one missing provider:
`src/lib/ai/imagegen.ts` defines the `ImageGenerator` interface + a stub.

## Auth + gates

`src/lib/auth.ts`: `isSiteAdmin(session)` (role==='admin') for platform actions;
`canEdit(session, ownerId)` for per-resource (admins always pass). `middleware.ts`
only enforces "signed in" for `/admin/*` and writes to `/api/images/*` /
`/api/comments/:id`. **Every admin handler must add its own `isSiteAdmin`/`canEdit`
gate.**

## Constraints that shape the features

- Serverless 60s function cap; cron 55s wall budget. Heavy passes must batch through the queue, not run inline.
- Embedding/enrichment is best-effort and async: a missing vector leaves a row usable and re-processable; never fail an upload on a model error.
- No em dashes anywhere (code, comments, generated text). Use `--`.
- `images.exif` is returned by the public list endpoint, so anything added there is published (GPS already stripped).
