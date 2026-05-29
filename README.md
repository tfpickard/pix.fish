# pix.fish

A multi-user image gallery with AI enrichment. Any signed-in GitHub user can upload; the rest of the world can browse, react, comment, report, and build shareable shelves. On each upload, the image is stored in Vercel Blob, EXIF and a color palette are extracted, and a background job generates three captions, three descriptions, and a tag set with a vision model plus a caption embedding for semantic search. One caption becomes the URL slug; the others rotate on display.

The full multi-phase product spec is in [SPEC.md](./SPEC.md). Implementation context for Claude Code is in [CLAUDE.md](./CLAUDE.md) -- treat CLAUDE.md and the code as authoritative where this README lags.

## What's in the box

| Capability | Status |
|---|---|
| Multi-user identity, per-user galleries (`/u/<handle>`) | shipped |
| Upload + AI captions/descriptions/tags | shipped |
| Async, queue-backed enrichment (Vercel Cron) | shipped |
| Per-user BYO provider keys (Anthropic/OpenAI, encrypted at rest) | shipped |
| DB-driven per-field provider routing (`/admin/ai`) | shipped |
| EXIF + palette extraction (no `sharp`) | shipped |
| Per-resource edit/delete, manual caption override | shipped |
| Caption embeddings + semantic search (`/api/search`) | shipped |
| "More like this" neighbors | shipped |
| NSFW classification + server-side gating | shipped |
| Anonymous reactions, comments (with moderation), reports | shipped |
| Anonymous shareable collections / shelves (`/c/<slug>`) | shipped |
| Embedding "breed" tool (synthetic descriptions) | shipped |
| UMAP atlas (`/map`) | shipped |
| Color pages (`/color/<hex>`) | shipped |
| Outbound webhooks + delivery history | shipped |
| Background jobs admin, backup export | shipped |
| PWA (share target, service worker) + JSON feed | shipped |

## Stack

- **Next.js 14** (App Router) + TypeScript + Tailwind + shadcn/ui
- **Neon Postgres** with `pgvector`, via `@vercel/postgres` + Drizzle ORM
- **Vercel Blob** for image storage
- **Vercel Cron** drains the DB-backed job queue (`/api/cron/jobs`, every minute)
- **Auth.js v5** -- GitHub OAuth. Any signed-in user can upload; `OWNER_GITHUB_ID` designates the bootstrap site admin (role-based, not an upload allowlist)
- **Anthropic** (`claude-sonnet-4-6`) for captions/descriptions/tags by default; **OpenAI** (`gpt-4o`) wired as an alternate provider, and `text-embedding-3-small` for caption embeddings. Routing is per-field and DB-driven; keys are per-user BYO with an env-var fallback
- **`exifr`** for EXIF, **`node-vibrant`** for palette (both pure-JS -- avoids `sharp`)
- **`umap-js`** for the atlas, **`serwist`** for the service worker, **`archiver`** for backup exports
- **bun** as package manager and script runner

## Local development

### 1. Prerequisites

```sh
bun --version    # >= 1.3
node --version   # >= 20 (Next.js still runs on Node under the hood)
```

### 2. Install

```sh
bun install
```

### 3. Environment variables

Copy `.env.example` to `.env.local` and fill in:

| Var | Required | Notes |
|---|---|---|
| `POSTGRES_URL` | yes | Pooled or unpooled Neon connection string. Grab from Neon or the Vercel Postgres integration. |
| `BLOB_READ_WRITE_TOKEN` | yes | Vercel dashboard -> Storage -> Blob -> create store -> Tokens. |
| `AUTH_SECRET` | yes | `openssl rand -hex 32`. Signs Auth.js sessions **and** is the PBKDF2 root for encrypting per-user provider keys. Rotating it invalidates all stored provider keys. |
| `AUTH_URL` | yes | `http://localhost:3000` for local dev. |
| `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` | yes | Create a GitHub OAuth app (Settings -> Developer settings). Homepage `http://localhost:3000`, callback `http://localhost:3000/api/auth/callback/github`. |
| `OWNER_GITHUB_ID` | yes | Your numeric GitHub user id. Look it up at `https://api.github.com/users/<username>`. Stamped `role='admin'` on first sign-in (taxonomy, prompts, ai_config, global /about). Not an upload allowlist -- any signed-in user can upload. |
| `ANTHROPIC_API_KEY` | yes | Env-var fallback for captions/descriptions/tags. Users may override with their own key via `/admin/keys`. |
| `OPENAI_API_KEY` | no | Caption embeddings (`text-embedding-3-small`), which power search, neighbors, breed, and the atlas. Without it, uploads still succeed but embeddings stay null. |
| `CRON_SECRET` | yes | `openssl rand -hex 32`. Bearer token gating `/api/cron/jobs`. Without it the queue never drains, so uploads never gain captions. See "Draining the queue locally" below. |
| `NEXT_PUBLIC_SITE_URL` | no | Canonical origin for SEO/JSON-LD/og:image. Falls back to `https://pix.fish`. |
| `GOOGLE_SITE_VERIFICATION`, `BING_SITE_VERIFICATION` | no | Search Console / Bing ownership verification codes. |

### 4. Database

```sh
bun run db:push     # drizzle-kit push -- applies the schema to Neon
bun run db:seed     # seeds prompt templates, taxonomy, ai_config defaults, and about fields (idempotent)
```

The migration under `drizzle/0000_init.sql` enables the `vector` extension before any tables are created. If you ever wipe the DB and re-push schema, run `bun scripts/ensure-pgvector.ts` first.

If you are migrating a legacy single-owner database, run `bun scripts/prepare-multiuser.ts` before `db:push` (stands up the `users` table) and `bun scripts/backfill-multiuser.ts` after (backfills `owner_id` to the admin user).

### 5. Run

```sh
bun run dev
```

Or use the `dev.sh` wrapper, which env-checks, manages a backgrounded process, and waits for HTTP 200 before returning -- handy when you want a server running across multiple terminal commands:

```sh
./dev.sh -vv start     # env-checked start, waits for http 200
./dev.sh status        # is it running? on what pid?
./dev.sh logs          # tail the dev log
./dev.sh restart       # stop then start
./dev.sh stop          # SIGTERM, then SIGKILL if needed
```

Open `http://localhost:3000`, click "sign in", and authorize the GitHub OAuth app. If your id matches `OWNER_GITHUB_ID` you'll also see site-admin nav links.

### 6. Upload

Drop an image on `/upload` (or `/admin/upload` for the bulk admin view), optionally add a manual caption / description / tags and flag NSFW, then upload. The route stores the blob, extracts EXIF + palette, inserts a row with a placeholder slug, and **enqueues an `enrich.image` job**, returning `202 { status: 'queued' }`. The vision calls run in the background; the UI polls `GET /api/images?ids=...` until captions appear.

### Draining the queue locally

Vercel Cron is what calls `/api/cron/jobs` in production. Locally, nothing fires it, so enrichment jobs sit `pending` until you drain them yourself:

```sh
curl -X POST http://localhost:3000/api/cron/jobs \
  -H "Authorization: Bearer $CRON_SECRET"
```

Run it after uploading (or on a loop) to process queued jobs. Check `/admin/jobs` to see queue state.

### 7. Backfill embeddings (optional)

If you imported images before embeddings shipped, or `OPENAI_API_KEY` was missing during some uploads:

```sh
bun scripts/backfill-embeddings.ts
```

Idempotent; uses `onConflictDoUpdate` on `(image_id, kind='caption')`. You can also requeue enrichment for selected images from `/admin/reprocess`.

## Deployment

1. **Vercel project**: import this repo. Framework preset: Next.js. Build command `bun run build`. Install command `bun install`.
2. **Neon Postgres**: add via the Vercel integration. It populates `POSTGRES_URL` and related env vars automatically. Run `bun run db:push` and `bun run db:seed` against the production database (or branch).
3. **Vercel Blob**: Dashboard -> Storage -> Create Blob Store. Link it to the project; `BLOB_READ_WRITE_TOKEN` is injected automatically.
4. **GitHub OAuth (prod)**: create a second OAuth app with callback `https://<your-domain>/api/auth/callback/github`. Set `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, and `AUTH_URL` in Vercel env.
5. **Secrets**: set `AUTH_SECRET`, `OWNER_GITHUB_ID`, `ANTHROPIC_API_KEY`, optionally `OPENAI_API_KEY`, and `CRON_SECRET` in Vercel env.
6. **Cron**: `vercel.json` registers `/api/cron/jobs` on a `* * * * *` schedule. Vercel sends the configured `CRON_SECRET` as a Bearer token; the queue does nothing without it.
7. **Route timeouts**: `/api/images` and `/api/cron/jobs` set `maxDuration = 60`. The cron drains in batches under a 55s wall budget; jobs that exceed their per-type timeout are retried with backoff.

## API surface

Public reads are unauthenticated. Writes require a session (enforced by `middleware.ts` for `/api/images/*` and `/api/comments/:id`); per-resource ownership and site-admin gates are checked inside the handlers via `canEdit()` / `isSiteAdmin()`. Admin APIs under `/api/admin/*` self-gate with `isSiteAdmin`.

### Public / signed-in

| Method | Path | Who | Purpose |
|---|---|---|---|
| `GET` | `/api/images` | public | paginated list (sort/seed/tag/NSFW params; `?ids=` for poll) |
| `POST` | `/api/images` | signed-in | upload, enqueue enrichment (returns 202) |
| `GET`/`PATCH`/`DELETE` | `/api/images/[slug]` | public / owner | detail, edit captions/manual fields, delete + cascade |
| `GET`/`POST` | `/api/images/[slug]/comments` | public | list approved / submit (guests land `pending`, signed-in `approved`) |
| `GET`/`POST` | `/api/images/[slug]/reactions` | public | summary / up-down toggle |
| `PATCH`/`DELETE` | `/api/comments/[id]` | owner | approve/reject, hard-delete |
| `POST` | `/api/reports` | public | report an image or comment |
| `GET` | `/api/search?q=...` | public | semantic search over caption embeddings |
| `GET` | `/api/u/[handle]/images` | public | a user's gallery |
| `*` | `/api/collections`, `/api/collections/[slug]/...` | public | create shelf, read, rename, add/remove items |
| `GET`/`POST`/`DELETE` | `/api/me/shelf` | public | the current visitor's default shelf |
| `GET` | `/api/color/[hex]/images` | public | images matching a palette hex |
| `GET` | `/api/umap` | public | latest cached UMAP projection |
| `GET` | `/api/gallery-config` | public | gallery sort/shuffle defaults |
| `POST` | `/api/nsfw-toggle` | public | set the `pf_show_nsfw` visibility cookie |
| `GET`/`POST`/`DELETE` | `/api/api-keys` | signed-in | personal REST tokens (hash stored) |
| `*` | `/api/prompts`, `/api/taxonomy` | public read / admin write | prompt + taxonomy CRUD |
| `GET`/`POST` | `/api/cron/jobs` | cron (Bearer `CRON_SECRET`) | drain the job queue |
| `POST` | `/api/share-target` | PWA | share-target receiver (forwards to upload) |

### Site admin (`/api/admin/*`, gated by `isSiteAdmin`)

`ai-config` (per-field routing), `breed`, `reprocess`, `jobs`, `stats`, `about/[key]` (+ `generate`), `saved-prompts` (+ `[id]/promote`), `umap/recompute`, `webhooks` (+ `[id]/deliveries`), `backup` (+ `[jobId]/download`).

## Scripts

```
bun run dev         # next dev
bun run build       # next build
bun run start       # next start
bun run lint        # next lint
bun run typecheck   # tsc --noEmit
bun run db:generate # drizzle-kit generate (emit a new migration)
bun run db:push     # drizzle-kit push (apply schema)
bun run db:seed     # seeds prompts, taxonomy, ai_config, about fields

bun scripts/seed.ts                  # same as db:seed
bun scripts/backfill-embeddings.ts   # generate caption embeddings for legacy rows
bun scripts/ensure-pgvector.ts       # idempotent CREATE EXTENSION vector
bun scripts/prepare-multiuser.ts     # stand up users table before db:push (legacy migration)
bun scripts/backfill-multiuser.ts    # backfill owner_id to the admin user (legacy migration)

./dev.sh [-v|-vv|-vvv] {start|stop|restart|status|logs}
```

## Project layout

```
src/
  app/
    page.tsx              # public home grid + tag cloud + rotating haiku tagline
    [slug]/page.tsx       # legacy bare-slug detail (resolves + redirects to /u/<handle>/<slug>)
    u/[handle]/           # per-user gallery (page.tsx) + detail ([slug]/page.tsx)
    c/[slug]/page.tsx     # collection / shelf detail
    color/[hex]/page.tsx  # palette-match gallery
    map/page.tsx          # UMAP atlas
    search/page.tsx       # semantic search
    about/page.tsx        # site-admin about fields
    upload/page.tsx       # public upload; admin/ has the bulk variant
    admin/                # site-admin pages (each self-gates): upload, gallery, ai, keys,
                          # prompts, saved-prompts, taxonomy, comments, breed, map, jobs,
                          # reprocess, stats, webhooks, backup, about
    api/                  # see "API surface" above
  components/             # shadcn UI primitives + page components (image-grid, upload-zone,
                          # umap-canvas, comment-list, save-to-shelf, sort-bar, ...)
  lib/
    ai/                   # AIProvider interface + anthropic/openai impls, per-field config,
                          # per-user key crypto (keys.ts), breed.ts
    prompts/              # resolve.ts (DB template + {{placeholders}}), compose.ts, fragments.ts
    jobs/                 # worker.ts + handlers/ (enrich, reprocess, umap, webhook, backup)
    db/                   # drizzle schema + one query file per concern (queries/)
    auth.ts               # Auth.js config + isOwner()/isSiteAdmin()/canEdit() gates
    enrichment.ts         # orchestrates parallel provider calls
    enrichment-persist.ts # writes captions/descriptions/tags/embedding + slug
    image-meta.ts         # exifr + node-vibrant extraction (pure-JS, GPS stripped)
    nsfw.ts               # show-NSFW cookie helper
    collections/          # shelf slug minting
    sort/                 # gallery sort/shuffle strategies
    search/, seo/, about/, webhooks/, site.ts, hash.ts, rate-limit.ts, http-params.ts, ...
scripts/                  # seed + backfill + migration helpers
drizzle/                  # 0000_init.sql (enables pgvector) .. 0003
middleware.ts             # "must be signed in" gate for /admin/*, /api/images writes, /api/comments writes
vercel.json               # registers the /api/cron/jobs cron
```

## Current limitations

- **Enrichment latency.** Uploads return immediately but captions appear only after the cron drains the queue (worst case ~60s in production; manual drain locally). Check `/admin/jobs` if a row stays caption-less.
- **Tag filter uses AND semantics only.** OR-toggle is planned.
- **Image dimensions not stored.** The `width`/`height` columns on `images` exist but are always null -- nothing probes them.
- **No CLIP / multimodal embeddings.** Only caption-text embeddings are written today. The `embeddings.kind` column reserves `image` and `combined` for later.

## Judgment calls worth knowing

The full plan lives in [`SPEC.md`](./SPEC.md); the short list of decisions that affect day-to-day work:

1. **Async enrichment.** `POST /api/images` enqueues an `enrich.image` job and returns 202; the queue (drained by `/api/cron/jobs`) does the vision calls. Failures retry with backoff and surface at `/admin/jobs`.
2. **Per-user BYO keys with env fallback.** Provider keys are AES-256-GCM encrypted in `provider_keys` (PBKDF2 from `AUTH_SECRET`); a user with no row falls back to the `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` env vars. A missing key for a field means that field is skipped, not a failed upload.
3. **Combined JSON per field.** One vision call returns all 3 caption variants (and same for descriptions). The `{{variant_number}}` placeholder is wired but currently unused.
4. **Manual caption is variant 4.** Stored as `variant=4, locked=true, isSlugSource=true`, not a replacement of an AI variant.
5. **Random caption on display is server-side per request.** No stability across refreshes; intentional. Don't add client-side caching that fights this.
6. **NSFW is gated server-side.** Rows flagged NSFW (auto by the tag pass, or manual override) are filtered before the blob URL is sent, unless the visitor opts in via the `pf_show_nsfw` cookie.
7. **`pgvector` extension is enabled in migration 0.** Don't strip the `CREATE EXTENSION` from `0000_init.sql`.
8. **No native image processing.** Pure-JS only (`exifr`, `node-vibrant`). Anything requiring `sharp` or libvips needs another way.
9. **GPS EXIF is stripped before persisting.** `images.exif` is returned by public endpoints, so persisting GPS would publish GPS. See `src/lib/image-meta.ts`.
10. **Embeddings are best-effort, post-commit.** A failed embedding does not fail the upload; `scripts/backfill-embeddings.ts` or `/admin/reprocess` can fill it in later.
11. **No em dashes anywhere.** Use `--` (two hyphens). Project-wide style rule from the bootstrap prompt in SPEC.md.

## License

See [LICENSE](./LICENSE).
