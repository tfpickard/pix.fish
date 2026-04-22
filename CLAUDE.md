# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Orientation

**pix.fish** is a single-owner image gallery with AI enrichment. README.md has local dev setup, env vars, and scripts; SPEC.md has the full multi-phase product spec. This file captures what isn't obvious from those two documents.

The repo is currently on **Phase 1** (sync enrichment, no embeddings, no engagement). `src/lib/db/schema.ts` has a comment block listing the Phase 2+ tables that are intentionally not created yet — don't add them without being asked.

## Commands

Package manager is **bun** (`bun.lock` is authoritative — never introduce `npm`/`pnpm`/`yarn` lockfiles). Scripts are in `package.json`; most common:

```sh
bun run dev         # next dev
bun run build       # next build
bun run lint        # next lint
bun run typecheck   # tsc --noEmit
bun run db:push     # drizzle-kit push (apply schema to Neon)
bun run db:seed     # seeds prompt templates + tag taxonomy (idempotent)
bun scripts/seed.ts # direct invocation of the seed script
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
2. Insert `images` row with a **placeholder slug** (`img-<blobkey-tail>`).
3. Call `enrichImage()` — runs captions/descriptions/tags **in parallel** via `Promise.all`. On failure the row is left with the placeholder slug so the owner can retry; we don't rollback the blob.
4. Inside a single `db.transaction`, insert captions+descriptions+tags and update the slug to the `slugify(first_caption)` result (or `manualCaption` if provided). `uniquifySlug` appends `-2`, `-3`, … on collision.
5. Manual captions are stored as `variant=4, locked=true, isSlugSource=true`, *not* as a replacement for one of the 3 AI variants. The AI variants are always variants 1–3.

`export const maxDuration = 60` on this route — Hobby-tier Vercel without Fluid Compute caps regular routes at 10s and will fail the upload. README §Deployment item 6 covers this.

### Auth + owner gating

Two independent gates, both required:

1. **`middleware.ts`** — Auth.js v5 wrapper. Redirects unauthenticated requests to `/admin/*`, 403s non-owner writes to `/api/images*`. Matcher is narrow (`['/admin/:path*', '/api/images/:path*']`); adding new owner-only surface area may require extending it.
2. **`isOwner(session)`** in `src/lib/auth.ts` — checked *inside* route handlers. Don't assume middleware alone is sufficient; it only runs for routes in the matcher.

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
- No `sharp` or native image libs. `width`/`height` on `images` are null until a future phase adds a pure-JS probe.
