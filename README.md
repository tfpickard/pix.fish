# pix.fish

A personal image gallery with AI enrichment. Single owner (Tom) uploads; the rest of the world can view, react, and comment. On each upload, images are stored and enriched with three captions, three descriptions, and tags drawn from a curated taxonomy plus free-form descriptors. One caption becomes the URL slug; the others rotate on display.

Full product spec: [SPEC.md](./SPEC.md).

This README covers **Phase 1 (Foundation)**: sync enrichment, no embeddings, no comments or reactions yet. Later phases add realtime streaming, embedding search, a UMAP map, and public engagement.

## Stack

- Next.js 14 (App Router) + TypeScript + Tailwind + shadcn/ui
- Neon Postgres with pgvector, via `@vercel/postgres` + Drizzle ORM
- Vercel Blob for image storage
- Auth.js v5 (GitHub provider, single-owner allowlist via `OWNER_GITHUB_ID`)
- Anthropic (claude-sonnet-4-6) for all vision calls by default; OpenAI (gpt-4o) available as an alternate provider
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

Copy `.env.example` to `.env.local` and fill in the values:

```sh
cp .env.example .env.local
```

| Var | Notes |
|-----|-------|
| `POSTGRES_URL` | Pooled or unpooled Neon connection string. Grab from Neon or the Vercel Postgres integration. |
| `BLOB_READ_WRITE_TOKEN` | Vercel dashboard -> Storage -> Blob -> create store -> Tokens. |
| `AUTH_SECRET` | `openssl rand -hex 32` |
| `AUTH_URL` | `http://localhost:3000` for local dev. |
| `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` | Create a GitHub OAuth app (Settings -> Developer settings). Homepage `http://localhost:3000`, callback `http://localhost:3000/api/auth/callback/github`. |
| `OWNER_GITHUB_ID` | Your numeric GitHub user id. Look it up at `https://api.github.com/users/<username>`. Only this user can upload or edit. |
| `ANTHROPIC_API_KEY` | Required. Used for captions, descriptions, tags. |
| `OPENAI_API_KEY` | Optional in Phase 1. Wired up but not the default provider. |

### 4. Database

Apply schema and run seeds:

```sh
bun run db:push     # drizzle-kit push, applies the schema to Neon
bun run db:seed     # seeds 3 prompt templates and ~120 taxonomy tags
```

The migration under `drizzle/0000_init.sql` also enables the `vector` extension so Phase 2 embeddings work with zero extra steps.

### 5. Run

```sh
bun run dev
```

Or use the `dev.sh` wrapper which checks required env vars and manages the background process:

```sh
./dev.sh -vv start     # env-checked start, waits for http 200
./dev.sh status        # is it running? on what pid?
./dev.sh logs          # tail the dev log
./dev.sh restart       # stop then start
./dev.sh stop          # kill cleanly (SIGTERM then SIGKILL)
```

Open `http://localhost:3000`, click "sign in", authorize the GitHub OAuth app, and if you're the owner you'll see an "upload" link in the nav.

### 6. Upload

Drop an image on `/admin/upload`, optionally add a manual caption, and click upload. The route runs 3 parallel vision calls (captions, descriptions, tags) and returns the full enriched record. Expect 15-40 seconds per upload with `maxDuration = 60` on the route.

## Deployment

1. **Vercel project**: import this repo. Framework preset: Next.js. Build command `bun run build`. Install command `bun install`.
2. **Neon Postgres**: add via the Vercel integration. It populates `POSTGRES_URL` and related env vars automatically. Run `bun run db:push` + `bun run db:seed` against the production database (or branch).
3. **Vercel Blob**: Dashboard -> Storage -> Create Blob Store. Link it to the project; `BLOB_READ_WRITE_TOKEN` is injected automatically.
4. **GitHub OAuth (prod)**: create a second OAuth app with callback `https://<your-domain>/api/auth/callback/github`. Set `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, and `AUTH_URL` in Vercel env.
5. **Secrets**: set `AUTH_SECRET`, `OWNER_GITHUB_ID`, `ANTHROPIC_API_KEY` in Vercel env.
6. **Route limits**: `POST /api/images` uses `maxDuration = 60`. Hobby tier limits regular routes to 10s; you'll need Fluid compute enabled or Pro tier for sync enrichment to complete. If you're on Hobby without Fluid, bump the work to Phase 2's async pipeline.

## Scripts

```
bun run dev         # next dev
bun run build       # next build
bun run start       # next start
bun run lint        # next lint
bun run typecheck   # tsc --noEmit
bun run db:generate # drizzle-kit generate
bun run db:push     # drizzle-kit push (applies schema)
bun run db:seed     # seeds prompts + taxonomy

./dev.sh [-v|-vv|-vvv] {start|stop|restart|status|logs}
```

## Project layout

```
src/
  app/
    page.tsx              # public home grid + tag cloud
    [slug]/page.tsx       # public image detail page
    admin/                # owner-only (middleware-gated)
    api/
      auth/[...nextauth]/ # Auth.js v5 route handler
      images/             # POST upload, GET list, PATCH /:slug
  components/             # shadcn UI primitives + page components
  lib/
    ai/                   # AIProvider interface + anthropic/openai impls + config
    prompts/              # resolve DB prompt templates w/ {{placeholders}}
    db/                   # drizzle schema + queries
    auth.ts               # Auth.js config + isOwner() helper
    slug.ts               # slugify + 80-char truncate
    enrichment.ts         # orchestrates provider calls in parallel
scripts/seed.ts           # idempotent prompts + taxonomy seed
drizzle/0000_init.sql     # initial migration (includes pgvector)
middleware.ts             # owner gate for /admin/* and write APIs
```

## Phase 1 limits

- **Synchronous enrichment.** Each upload blocks the POST for 15-40 seconds. Phase 2 moves this to a queue with WebSocket progress streaming.
- **No embeddings yet.** The `embeddings` table and vector index come in Phase 2. The `vector` extension is enabled.
- **No reactions or comments.** The detail page shows "coming in phase 3" placeholders.
- **No prompt/taxonomy/keys admin UIs.** Edit `scripts/seed.ts` and re-run `bun run db:seed` for now.
- **Tag filter uses AND semantics only.** Phase 2 adds the OR toggle.

## Judgment calls you should know about

The full Phase 1 plan lives in [`SPEC.md`](./SPEC.md); the short list of decisions worth knowing:

1. Combined JSON per field (one call returns all 3 variants) instead of 3 separate calls per field. Cheaper, faster, but `{{variant_number}}` placeholder is currently unused.
2. Manual caption is stored as a variant-4 caption with `locked=true`, not as a replacement of one of the AI variants.
3. `pgvector` extension is enabled in Phase 1 even though the `embeddings` table comes in Phase 2.
4. Random caption on display is picked server-side per request. No stability across refreshes; acceptable for Phase 1.
5. No native image-processing (no `sharp`). Width/height are null until Phase 2 adds a small pure-JS probe or EXIF reader.
