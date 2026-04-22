# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Orientation

**pix.fish** is a single-owner image gallery with AI enrichment. README.md has local dev setup, env vars, and scripts; SPEC.md has the full multi-phase product spec. This file captures what isn't obvious from those two documents.

Phase 2 has shipped (embeddings + semantic search, palette/EXIF extraction, delete endpoint, haiku titles); Phase 3 *schema* is in place (`reactions`, `comments`, `reports`) and visitor-facing engagement endpoints are wired (`/api/images/:slug/reactions`, `/api/images/:slug/comments`, `/api/reports`) along with owner moderation under `/api/comments/:id`. `src/lib/db/schema.ts:213-218` still lists Phase 4+ tables that are intentionally not created (`webhooks`, `jobs`, `ai_config`, `saved_prompts`) -- don't add them without being asked.

## Commands

Package manager is **bun** (`bun.lock` is authoritative — never introduce `npm`/`pnpm`/`yarn` lockfiles). Scripts are in `package.json`; most common:

```sh
bun run dev         # next dev
bun run build       # next build
bun run lint        # next lint
bun run typecheck   # tsc --noEmit
bun run db:generate # drizzle-kit generate (emit a new migration)
bun run db:push     # drizzle-kit push (apply schema to Neon)
bun run db:seed     # seeds prompt templates + tag taxonomy (idempotent)
bun scripts/seed.ts                  # direct invocation of the seed script
bun scripts/backfill-embeddings.ts   # generate caption embeddings for legacy rows
bun scripts/ensure-pgvector.ts       # idempotent CREATE EXTENSION vector
```

There are no unit tests yet. "Verify a change" = `bun run typecheck && bun run lint && bun run build`, plus hitting the feature in a browser.

The `dev.sh` wrapper (`./dev.sh start|stop|restart|status|logs`) launches `bun run dev` as a detached background process with env-var preflight and port-bind checks. Prefer it over `bun run dev` when you need Claude to leave a server running between tool calls — it writes to `.dev-server.pid` and `.dev-server.log` and waits for HTTP 200 before returning. Use `-v`/`-vv` for diagnostics when startup fails.

## Architecture

### AI provider abstraction (`src/lib/ai/`)

Everything that calls a vision model goes through `AIProvider` (`types.ts`). Rules enforced across the codebase:

- **Providers don't own prompts.** The prompt string is passed in as an argument. If you're tempted to hardcode prompt text inside `anthropic.ts` or `openai.ts`, stop — prompts come from the DB via `src/lib/prompts/resolve.ts`.
- **No direct SDK calls outside `src/lib/ai/`.** Route handlers and components must go through `getProvider(field)` in `src/lib/ai/index.ts`.
- **Per-field routing** (`captions`/`descriptions`/`tags`) lives in `src/lib/ai/config.ts`. Phase 1 hardcodes all three to `anthropic`; Phase 3 moves this into the `ai_config` DB table.
- **Response parsing helpers** (`parseVariantsJson`, `parseTagsJson` in `types.ts`) strip ```json fenced blocks — use them from new provider implementations rather than re-rolling the parsing.

### Prompt resolution (`src/lib/prompts/`)

Prompts are seeded into the `prompts` table by `scripts/seed.ts`, keyed by `caption` | `description` | `tags`. `resolvePrompt(key, ctx)` reads the template and substitutes `{{tag_taxonomy}}`, `{{existing_caption}}`, `{{variant_number}}`. If you add a new placeholder, add it here *and* update the seed script's templates.

Editing a prompt in production (Phase 3 feature) = updating the `prompts` row; no redeploy needed.

### Upload flow (`src/app/api/images/route.ts`)

`POST /api/images` is deliberately shaped around "image survives enrichment failure":

1. Upload buffer to Vercel Blob first.
2. Extract EXIF (`exifr`) and a 5-color palette (`node-vibrant`) from the buffer in parallel via `src/lib/image-meta.ts`. Both pure-JS, no `sharp`. Both helpers swallow errors; on failure the row just gets `null` for that column. EXIF supplies `takenAt`; GPS fields are deliberately stripped before persisting (see `image-meta.ts:17-21`).
3. Insert `images` row with a **placeholder slug** (`img-<blobkey-tail>`) plus the EXIF/palette/`takenAt` columns.
4. Call `enrichImage()` (in `src/lib/enrichment.ts`, not the route) -- runs captions/descriptions/tags **in parallel** via `Promise.all`. On failure the row is left with the placeholder slug so the owner can retry; we don't rollback the blob.
5. Inside a single `db.transaction`, insert captions+descriptions+tags and update the slug to the `slugify(first_caption)` result (or `manualCaption` if provided). `uniquifySlug` appends `-2`, `-3`, ... on collision. The previous slug is appended to `slug_history` (GIN-indexed) so old URLs keep resolving.
6. Manual captions are stored as `variant=4, locked=true, isSlugSource=true`, *not* as a replacement for one of the 3 AI variants. The AI variants are always variants 1-3.
7. After the transaction commits, generate a caption embedding (`text-embedding-3-small`, 1536d) and `upsertEmbedding`. Failures are logged and swallowed -- the image stays usable; `scripts/backfill-embeddings.ts` can fill it in later.

`export const maxDuration = 60` on this route — Hobby-tier Vercel without Fluid Compute caps regular routes at 10s and will fail the upload. README §Deployment item 6 covers this.

### Embeddings + search (`src/lib/db/queries/embeddings.ts`, `src/app/api/search/route.ts`)

Phase 2 writes only `kind='caption'` embeddings (1536d, OpenAI `text-embedding-3-small`). The `embeddings` table is `UNIQUE (image_id, kind)` so writes use `onConflictDoUpdate` -- safe to re-run. `image` and `combined` kinds are reserved for a future CLIP/multimodal pass.

- `/api/search?q=...` -- text query embedded then cosine-ranked against caption embeddings.
- "More like this" / neighbors -- same query helper, seeded from an existing image's vector.
- The `vector` extension is enabled by `drizzle/0000_init.sql`; if you ever wipe the DB and re-push schema, run `bun scripts/ensure-pgvector.ts` first.

### Engagement (`src/app/api/images/[slug]/{comments,reactions}`, `src/app/api/comments/[id]`, `src/app/api/reports`)

Anonymous, IP-hash gated. `src/lib/hash.ts` does the hashing; `src/lib/rate-limit.ts` is the throttle.

- **Reactions** -- `UNIQUE (image_id, ip_hash)`. Re-POSTing the same `kind` toggles off; a different `kind` swaps. `fingerprint` (client UUID in localStorage) is a secondary de-dupe signal. Public POST at `/api/images/:slug/reactions`.
- **Comments** -- public POST at `/api/images/:slug/comments`; owner-only PATCH/DELETE at `/api/comments/:id` (moderation queue). Status flows `pending -> approved | rejected`; only `approved` is publicly visible.
- **Reports** -- public POST at `/api/reports`. `target_type` is `'image' | 'comment'`; surfaces in the admin moderation queue.

### Auth + owner gating

Two independent gates, both required:

1. **`middleware.ts`** -- Auth.js v5 wrapper. Redirects unauthenticated requests to `/admin/*`, 403s non-owner writes to `/api/images*` (POST/PATCH/DELETE) and owner-only moderation actions on `/api/comments/:id` (PATCH/DELETE). Matcher: `['/admin/:path*', '/api/images/:path*', '/api/comments/:path*']`. The other admin APIs (`/api/api-keys`, `/api/taxonomy`, `/api/prompts`) are NOT in the matcher and rely on in-handler `isOwner()` -- if you add a new admin endpoint outside those three matched paths, both gates apply.
2. **`isOwner(session)`** in `src/lib/auth.ts` -- checked *inside* route handlers. Don't assume middleware alone is sufficient; it only runs for routes in the matcher.

Owner identity is `session.user.githubId === process.env.OWNER_GITHUB_ID`, populated via the JWT callback that copies `profile.id` to the token. GitHub handles/emails are not used for gating.

### Database (`src/lib/db/`)

- Drizzle ORM on top of `@vercel/postgres`. Schema in `schema.ts`; config in `drizzle.config.ts` (reads `POSTGRES_URL`).
- `drizzle/0000_init.sql` enables the `vector` extension up front even though the `embeddings` table is Phase 2 — don't strip this.
- Query helpers live in `src/lib/db/queries/*.ts` (one file per concern: images, slugs, tags, prompts, taxonomy). Route handlers import from here; they shouldn't build Drizzle queries inline.

## Conventions

- **No em dashes** in code, comments, or prose. Use `--` (two hyphens). This is a project-wide style rule originating in the bootstrap prompt in SPEC.md; the whole codebase follows it.
- Comments explain *why*, not *what*. The existing code is a good reference for tone — see `src/app/api/images/route.ts` comments about placeholder slugs and transaction boundaries.
- Error handling at external boundaries (blob upload, provider calls, DB) returns a structured `NextResponse.json({ error }, { status })`; internal helpers throw.
- Provider/model names are persisted per-row on captions/descriptions/tags so reprocessing (Phase 4) can diff them against current config.

## Known judgment calls

Listed in README §"Judgment calls you should know about". The ones most likely to trip up future work:

- Captions/descriptions are **one JSON call returning 3 variants** per field, not 3 separate calls. `{{variant_number}}` is wired but unused in Phase 1 templates.
- Random caption/description **selection is server-side per request** — no stability across page refreshes. Don't add client-side caching that fights this without checking first.
- No `sharp` or native image libs. EXIF + `takenAt` come from `exifr`; palette comes from `node-vibrant` (both pure-JS). `width`/`height` columns exist on `images` but are still null -- `image-meta.ts` does not probe dimensions.
- Embedding writes are best-effort and fire after the upload transaction commits. A failed embedding does NOT fail the upload; it leaves the row eligible for `scripts/backfill-embeddings.ts`.
- GPS EXIF fields are stripped before persisting (`image-meta.ts:17-21`). `images.exif` is returned by the public list endpoint, so adding GPS back means publishing GPS -- requires a separate private column or server-side redaction first.
