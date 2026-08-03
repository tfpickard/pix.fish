# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Orientation

**pix.fish** is a multi-user image gallery with AI enrichment. Any signed-in GitHub user can upload; the rest of the world can browse, react, comment, report, and build shareable shelves. README.md has local dev setup and env vars; SPEC.md has the full multi-phase product spec (and the phase letters A-F referenced in commit messages). This file captures what isn't obvious from those two documents.

It started as a single-owner gallery and the README/.env.example still read that way in places -- treat **this file and the code as authoritative** when they disagree with the README. The build has since shipped multi-user (per-user identity, per-user BYO provider keys), async queue-backed enrichment, NSFW classification + gating, anonymous collections/shelves, an embedding-driven "breed" tool, a UMAP atlas, webhooks, and a background job system. Every table the old spec listed as "Phase 4+, not created" now exists in `src/lib/db/schema.ts` -- so the prior rule about not creating `webhooks`/`jobs`/`ai_config`/`saved_prompts` no longer applies; they are live.

## Commands

Package manager is **bun** (`bun.lock` is authoritative -- never introduce `npm`/`pnpm`/`yarn` lockfiles). Scripts from `package.json`:

```sh
bun run dev         # next dev
bun run build       # next build (runs serwist SW codegen via next.config.mjs)
bun run lint        # next lint
bun run typecheck   # tsc --noEmit
bun run db:generate # drizzle-kit generate (emit a new migration)
bun run db:push     # drizzle-kit push (apply schema to Neon)
bun run db:seed     # bun scripts/seed.ts -- seeds prompts, taxonomy, ai_config, about fields (idempotent)
```

One-off scripts (run with `bun scripts/<name>.ts`):

```sh
seed.ts                  # same as db:seed
backfill-embeddings.ts   # caption embeddings for legacy rows (uses the env ANTHROPIC/OPENAI keys)
ensure-pgvector.ts       # idempotent CREATE EXTENSION vector
prepare-multiuser.ts     # pre-migration: stand up users table before db:push (bootstrap)
backfill-multiuser.ts    # backfill owner_id on legacy single-owner rows to the admin user
sync-dispatch-prompt.ts  # move the live dispatch_caption row to the checked-in default, skipping admin-edited rows (--apply to write)
migrate-dispatch-model.ts # move the ai_config dispatch row off the former shared default and add dispatchSafety (--apply to write)
```

Note the asymmetry there: `seed.ts` upserts and so **overwrites the template of every prompt key**, discarding admin edits made at `/admin/prompts`. That makes it the wrong tool for shipping a prompt change to a live install. `sync-dispatch-prompt.ts` is the right one -- it only advances a row whose content still hashes to a default this repo has shipped. Any new prompt-constant change needs the outgoing hash appended to `SHIPPED_DEFAULT_HASHES`, or the update will read as an admin edit and be skipped forever.

There are no unit tests. "Verify a change" = `bun run typecheck && bun run lint && bun run build`, plus exercising the feature in a browser.

The `dev.sh` wrapper (`./dev.sh start|stop|restart|status|logs`) launches `bun run dev` as a detached background process with env preflight and port-bind checks. Prefer it over `bun run dev` when you need a server to persist between tool calls -- it writes `.dev-server.pid`/`.dev-server.log` and waits for HTTP 200 before returning. Use `-v`/`-vv` for startup diagnostics.

## Architecture

### Multi-user identity, handles, and routing

- A signed-in user is one row in the `users` table (`schema.ts:25`). The PK `id` is the provider-scoped id (GitHub numeric id as text). `handle` is the URL-safe public identifier used in `/u/<handle>/...`; collisions get a `-2`, `-3`, ... suffix resolved at sign-in by `resolveHandle()` (`auth.ts:23`). `role` is `'user' | 'admin'`.
- The bootstrap admin is whoever matches `OWNER_GITHUB_ID`; the JWT callback stamps their role `admin` and upserts the row on first sign-in (`auth.ts:57-99`). Role is set deterministically *before* the DB upsert so a transient DB failure can't lock the admin out.
- URL shapes: canonical detail is `/u/<handle>/<slug>`; per-user gallery is `/u/<handle>`. The legacy bare `/<slug>` still resolves (and redirects) for back-compat. Slugs are unique **per owner** (`images_owner_slug_uniq`, `schema.ts:69`), so two users can both own `/u/*/sunset`.

### Auth + three gates (`src/lib/auth.ts`, `src/middleware.ts`)

The old single `isOwner()` gate has been split. All three live in `auth.ts`:

- `isOwner(session)` (`auth.ts:120`) -- **legacy**, compares `session.user.githubId === OWNER_GITHUB_ID`. Being migrated out; don't add new call sites.
- `isSiteAdmin(session)` (`auth.ts:130`) -- `session.user.role === 'admin'`. Use for platform-wide actions (taxonomy, prompts, ai_config, the global /about and landing config).
- `canEdit(session, resourceOwnerId)` (`auth.ts:138`) -- per-resource ownership; site admins always pass so they can moderate/rescue any user's content. Use for image edit/delete and any per-user resource.

`src/middleware.ts` enforces only **"must be signed in"** for `/admin/*` (redirect) and writes to `/api/images/*` and `/api/comments/:id` (403). It deliberately does **not** check ownership -- that needs a DB read and is done inside handlers via `canEdit`/`isSiteAdmin`. Any admin API the auth gate doesn't cover relies entirely on its in-handler gate, so always add an explicit `isSiteAdmin`/`canEdit` check in new handlers. Non-admin users can reach `/admin/*` pages; each page self-gates. `POST /api/images/:slug/{reactions,comments}` are carved out of the write gate: both are anonymous-public by design.

**The file must live at `src/middleware.ts`.** This project has a `src` directory, so Next.js only picks up middleware from inside it; the copy that sat at the repo root through phase F compiled to nothing and never ran a single request. Anything that looks like it should be enforced at the edge needs a `.next/server/middleware-manifest.json` check before you believe it.

The matcher is now a catch-all because the same file also carries the per-IP edge rate limiter (`src/lib/edge-rate-limit.ts`). Widening it did not widen the auth gate -- `authGateFor()` still restricts that to the original three prefixes and the write methods, and everything else only passes through the limiter. Consulting it *before* invoking the NextAuth wrapper is deliberate: the wrapper verifies the session JWT before its callback runs, which is wasted on every public `GET /api/images`.

Three things about that middleware are load-bearing and easy to undo by accident:

- **The matcher excludes a named inventory of `public/`, never a file-extension pattern.** `/anything.png` matches no static file but still resolves through `src/app/[slug]/page.tsx`, so an `*.png` exclusion silently hands out a family of DB-backed paths that never reach the limiter. Add to the list when you add to `public/`.
- **Prefix checks are segment-aware** (`underPath`). Bare `startsWith('/admin')` also catches `/administration`, which the legacy bare-slug route serves -- that would cost any image slug beginning "admin" its public URL.
- **`/api/cron/*` skips the limiter only with a valid `CRON_SECRET` bearer**, not by path. All four cron routes use the identical `Bearer ${process.env.CRON_SECRET}` comparison; a path-only exemption would let anyone turn a public URL into unlimited Node invocations.

See `docs/rate-limiting.md` for how the three limiter layers relate.

### AI provider abstraction (`src/lib/ai/`)

Everything that calls a vision/embedding model goes through `AIProvider` (`types.ts`). Files: `anthropic.ts`, `openai.ts` (implementations), `index.ts` (`getProvider`/`getEmbedder` factories), `config.ts` (defaults), `loadConfig.ts` (DB-backed config), `keys.ts` (per-user key crypto + loading), `breed.ts` (embedding-centroid generation), `types.ts` (interface + JSON parsers). The interface has required `captions`/`descriptions`/`tags` plus optional `text?` (breed-only) and `embed?`/`embedModel?` (embeddings-only).

Rules enforced across the codebase:

- **Providers don't own prompts.** The prompt string is passed in. Prompts come from the DB via `src/lib/prompts/resolve.ts`; never hardcode prompt text in a provider.
- **No direct SDK calls outside `src/lib/ai/`.** Route handlers and jobs go through `getProvider(field, cfg, keys)` / `getEmbedder(cfg, keys)` in `index.ts`.
- **Per-field routing is DB-driven now.** `loadAiConfig()` (`loadConfig.ts`) reads the `ai_config` table (fields `captions`/`descriptions`/`tags`/`embeddings`), falling back to `defaultAiConfig` (`config.ts`: Anthropic for the three text fields, OpenAI `text-embedding-3-small` for embeddings). The owner edits routing via `/admin/ai` -> `/api/admin/ai-config`.
- **Keys are per-user BYO, encrypted at rest.** `keys.ts` stores AES-256-GCM ciphertext (`base64(iv||tag||ciphertext)`) in `provider_keys`, with the key derived from `AUTH_SECRET` via PBKDF2 (`keys.ts:11-31`). Plaintext is never persisted, returned, or logged. `loadUserProviderKeys(userId)` decrypts a user's rows and **falls back to the `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` env vars** when a user has no row -- this preserves the single-owner deployment during the transition. Rotating `AUTH_SECRET` invalidates all stored keys by design (no key versioning).
- `getProvider`/`getEmbedder` **return `null`** when the configured provider has no usable key for the current user. Callers must treat null as "skip this field" -- enrichment emits empty arrays so the upload still succeeds.
- **No SDK client cache** (`index.ts:6-10`): each call constructs a fresh client because the per-user apiKey is a construction arg; pooling would risk leaking keys across users.
- **Response parsing helpers** (`parseVariantsJson`, `parseTagsJson` in `types.ts`) strip ```json fences -- use them from new provider impls.

### Prompt resolution (`src/lib/prompts/`)

Seeded into the `prompts` table by `scripts/seed.ts`. There are now **seven** keys (`src/lib/db/queries/prompts.ts:13`): `caption`, `description`, `tags`, plus the breed family `breed`, `depart`, `antibreed`, `subtract`. `resolvePrompt(key, ctx)` (`resolve.ts`) substitutes `{{tag_taxonomy}}`, `{{existing_caption}}`, `{{variant_number}}`, and the breed placeholders (`{{source_captions}}`, `{{neighbor_captions}}`, `{{far_neighbor_captions}}`, `{{anchor_caption}}`, `{{subtract_captions}}`, `{{n_sources}}`). Adding a placeholder means updating `resolve.ts` *and* the seed templates.

`compose.ts` + `fragments.ts` back the prompt composer: users build prompt variants from reusable fragments and save them to `saved_prompts`; a site admin can **promote** a saved prompt (`/api/admin/saved-prompts/:id/promote`), which overwrites `prompts.template` for that key and bumps `prompts.version`. Editing a live prompt = updating the `prompts` row; no redeploy.

### Upload flow is asynchronous now (`src/app/api/images/route.ts` + job queue)

This is the biggest change from the original design. `POST /api/images` no longer enriches inline. It:

1. Authorizes any signed-in user (ownership enforced later via `canEdit`).
2. Uploads the buffer to Vercel Blob first (URL survives enrichment failure).
3. Extracts EXIF (`exifr`) + a 5-color palette (`node-vibrant`) from the buffer in parallel via `src/lib/image-meta.ts` (both pure-JS, no `sharp`; both swallow errors -> `null` column). EXIF supplies `takenAt`; **GPS fields are stripped before persisting** (`image-meta.ts`).
4. Inserts the `images` row with a **placeholder slug** (`img-<blobkey-tail>`), stamped with `ownerId`.
5. **Enqueues an `enrich.image` job** (`enqueueJob`) and returns **HTTP 202 `{ status: 'queued' }`**. It does not wait for the model.

The upload UI fires N parallel uploads and polls `GET /api/images?ids=...` to watch each row gain captions. `maxDuration = 60` is still set, but the route is now thin.

### Background job queue (`src/lib/jobs/`, `src/app/api/cron/jobs`)

A DB-backed queue replaces synchronous work. The `jobs` table (`schema.ts:394`) is leased with a **visibility timeout** (`lockedAt`) rather than `FOR UPDATE`, so a function dying mid-handler doesn't orphan rows.

- **Drain endpoint**: `/api/cron/jobs` (`route.ts`), invoked every minute by Vercel Cron (`vercel.json`). GET = cron, POST = ad-hoc/manual drain. Both require `Authorization: Bearer ${CRON_SECRET}`. It reclaims stuck `processing` rows older than a 5-min visibility timeout, then claims/runs batches of 10 until a 55s wall budget.
- **Worker**: `worker.ts` dispatches by `job.type` through `handlers/index.ts`, wraps each in a per-type timeout (kept under the cron wall budget), and on failure reschedules with exponential backoff up to `maxAttempts`, then marks `failed` (visible at `/admin/jobs`).
- **Handlers** (`src/lib/jobs/handlers/`): `enrichImage` (the real captions/descriptions/tags + embedding work, persisting via `src/lib/enrichment-persist.ts`), `reprocessImage`, `umapRecompute`, `webhookDeliver`, `backupExport`. `src/lib/enrichment.ts` is the provider-orchestration core called by the enrich/reprocess handlers (3 parallel field calls; skips any field with no key).

When debugging "my upload has no caption," check the `jobs` table / `/admin/jobs`, not the upload route.

### Enrichment internals (`src/lib/enrichment.ts`, `enrichment-persist.ts`)

`enrichImage()` runs captions/descriptions/tags in parallel; each field is skipped (empty array) if its provider has no key. The tag pass **also returns an NSFW verdict** (`TagsAndNsfw`), and `tagsRan` distinguishes "AI ran, no tags" from "no key, didn't run." Persistence (in `enrichment-persist.ts`) writes captions as variants 1-3, a manual caption as `variant=4, locked=true, isSlugSource=true`, updates the slug to `slugify(first_caption)` (with `uniquifySlug` + `slug_history` GIN-indexed for old-URL resolution), and writes the caption embedding best-effort after commit.

### NSFW (`src/lib/nsfw.ts`, `images.isNsfw`/`nsfwSource`)

NSFW is classified by the tag pass (`nsfwSource='auto'`) or asserted by the uploader (`manual_nsfw` checkbox -> `nsfwSource='manual'`); manual never gets clobbered by a later auto pass. Gating is **server-side at the query layer**: the public stream hides NSFW rows unless the visitor opts in via the `pf_show_nsfw=true` cookie (`SHOW_NSFW_COOKIE`), toggled through `/api/nsfw-toggle`. Default-hide is enforced before sending the row down the wire (the blob URL is never shipped to an opted-out visitor). A query param (`include_nsfw`, parsed by `http-params.ts`) can override the cookie for admin tooling.

### Breed tool (`src/lib/ai/breed.ts`, `/admin/breed` + `/api/admin/breed`)

Generates synthetic descriptions by doing vector math on existing caption embeddings, then asks the LLM to render the result. Four modes: `breed` (centroid of sources), `depart` (centroid, prompted to move away), `antibreed` (centroid but seeded with *farthest* references), `subtract` (anchor - mean(others)). It needs >=2 embedded sources (or an anchor + >=1 subtract). Output includes nearest existing images to the new point. `BreedError` codes surface the precise precondition that failed.

### Embeddings + search (`src/lib/db/queries/embeddings.ts`, `/api/search`)

Only `kind='caption'` (1536d) is written today; `image`/`combined` are reserved for a future CLIP/multimodal pass. `UNIQUE (image_id, kind)` so writes use `onConflictDoUpdate`. `/api/search?q=...` embeds the query then cosine-ranks; "more like this"/neighbors seed from an existing vector. The `vector` extension is enabled in `drizzle/0000_init.sql` -- if you wipe and re-push, run `bun scripts/ensure-pgvector.ts` first.

### UMAP atlas (`/map`, `/admin/map`, `umap_projections` table)

`umap-js` projects caption embeddings to 2D. The projection is **cached** in `umap_projections` (newest row matching the param cache key); recompute is a `umap.recompute` job triggered from `/admin/map`. Rendered client-side by `umap-canvas.tsx` / `embedding-viz.tsx`.

### Collections / shelves (`collections`, `collection_items`, `/c/<slug>`, `/api/collections`)

Anonymous-friendly shareable "shelves." `ownerHash` is the visitor's `ip_hash` (or the `user.id` for signed-in users) so authorization is one comparison; `fingerprint` (localStorage UUID) is a secondary de-dupe. Slugs are human-readable (`adjective-noun-NNNN`) so they share without leaking IDs (minted in `src/lib/collections/slug.ts`). `/api/me/shelf` is the current visitor's default shelf.

### Engagement (`/api/images/:slug/{reactions,comments}`, `/api/comments/:id`, `/api/reports`)

Anonymous, IP-hash gated (`src/lib/hash.ts` + `src/lib/rate-limit.ts`).

- **Reactions** -- `UNIQUE (image_id, ip_hash)`; re-POST same kind toggles off, different kind swaps.
- **Comments** -- public POST at `/api/images/:slug/comments`; owner moderation PATCH/DELETE at `/api/comments/:id`. Status `pending -> approved | rejected`, only `approved` is public. **Signed-in users skip moderation** (default `approved`); guests default `pending`, may supply `author_name`, and get city/region/country auto-captured from Vercel edge headers (`geoCity`/`geoRegion`/`geoCountry`). `userId` is `ON DELETE SET NULL` so a removed account leaves the comment standing as a guest row.
- **Reports** -- public POST; separate `imageId`/`commentId` FK columns (not polymorphic) so deletes cascade.

### Outbound X dispatch (`src/lib/dispatch/`, `/api/cron/dispatch`, `/admin/dispatch`)

One image a day, posted to the site's X account tagged into a currently-trending topic, with a caption engineered to never address that topic. The comedy is the miss, so the tone contract in the `dispatch_caption` prompt is the spec, not the plumbing.

- **Trend source is not the posting target.** Trends come from Google Trends' public RSS feed (free, no credentials, and it carries news headlines per topic -- X's own trends endpoint is pay-per-use and returns a bare string the safety gate cannot reason about). `trends.ts` holds a `TrendSource` shape so another source can drop in.
- **The safety gate runs first and fails closed in every direction** (`safety.ts`). A deterministic denylist over topic + headlines, then one batched Haiku call; a candidate needs `safe === true`, `confidence === 'high'`, and an allowlisted category. Unparseable JSON, a thrown error, a missing key, or an empty result all mean no post. **"No post today" is a correct outcome**, so every failure path writes a `dispatch.skipped` event rather than throwing.
- **Manual dispatches are drafted, reviewed, then approved; only cron posts unattended.** A manual run always writes a dry-run `dispatch.sent` and never posts. `POST /api/admin/dispatch/approve` enqueues `x.dispatch.publish`, which posts **that stored draft verbatim** -- it must never regenerate, because a fresh caption would not be the one approved. The publish job re-checks everything that can change between drafting and publishing (live config, `currentPostState`, the specimen lock, the clock); a draft is a proposal, not a permit. Approval is deduped on the draft id (`dedupeKey.dispatchApproval`), so one draft publishes once. The scheduled dispatch deliberately skips all of this: it fires at a randomized minute with nobody watching.
- **One *scheduled* dispatch per day is structural, not scheduled.** The handler's first act is a `dispatch.claimed` event keyed `x.dispatch:<YYYY-MM-DD>`; `appendEvent`'s unique dedupe index makes a second claim a no-op. A double-fired cron and a reclaimed job collapse to one run. The cap binds the **scheduler**, not the account: manual runs from `/admin/dispatch` (dry review *and* live) claim a `manual:<ms>` suffixed slot and are deliberately **unlimited** -- an admin posting several times in a day is a decision, a cron doing it is a bug. A manual live post cancels that day's scheduled one, which `/api/cron/dispatch` enforces via `livePostAttemptedOnDate()` (advisory; the cron-vs-cron guarantee is still the day-claim). Concurrency, not frequency, is guarded on the manual path: `hasInFlightJobOfType` serializes runs so two cannot select the same specimen before either records its attempt.
- **Correlate dispatch events by `payload.slotKey`, never by date.** `subjectId` is only the UTC date and a date can hold many runs, so a review run's outcome would otherwise vouch for a scheduled run's unresolved attempt. All three of `dispatch.attempted`/`sent`/`skipped` carry the slot.
- **A live run rechecks the UTC date immediately before posting** (cron trigger only). A run starting at 23:59 and posting at 00:00 would publish into a day it never claimed, and that day's own dispatch still fires later. Manual runs are exempt because they have no per-day budget to overspend.
- Cron fires on a coarse grid (`vercel.json`) and `schedule.ts` decides whether today's date-seeded fire time has passed -- Vercel Cron cannot jitter, and a dispatch landing at the same minute daily reads as a machine. Enqueued with `maxAttempts: 1`: **never retried.**
- Specimen selection (`select.ts` + `src/lib/db/queries/dispatch.ts`) takes a *middle band* of cosine distance from the trend vector: nearer and the specimen is genuinely about the trend, further and there is no thread. Whole corpus eligible, NSFW included by product decision, recency a weight rather than a filter, already-dispatched images excluded from the log.
- LLM calls go through `src/lib/ai/dispatch-text.ts`, not `AIProvider.text()`: that path hardcodes 4096 tokens and the SDK's two retries, and this job needs tight caps and `maxRetries: 0`. It speaks Anthropic only and returns null otherwise, which callers treat as skip.
- **Two ai_config rows, not one.** `dispatch` routes the caption (the deliverable -- a better tier earns its cost, including a thinking model); `dispatchSafety` routes the trend classifier (mechanical batch-in/JSON-out under a deadline that must fit inside a 50s job, so reasoning buys nothing and costs the post). One row meant choosing a caption model silently dragged the classifier with it. Pass `field` to `dispatchText`; it defaults to `dispatch` so an unspecified call never silently picks the cheap tier for creative work.
- **Token caps must clear a thinking budget, not just the visible output.** Thinking tokens come out of the same `max_tokens` and are spent before any text, so an undersized cap on a thinking model returns a response with *no text block at all* -- and, when thinking just fits, a truncated JSON array. One cause, two symptoms. A cap too small does not save money; the call is billed and the day is lost. Size for sufficiency first.
- **Dry run is the default.** Live posting needs `X_DISPATCH_LIVE=true` AND all four OAuth 1.0a credentials; either missing degrades to a dry run rather than failing. The assembled post is written in full to `dispatch.sent` and reviewed at `/admin/dispatch` or via `bun run dispatch:dryrun`. Guard constants live in `dispatch/config.ts` and are asserted by `tests/dispatch.test.ts` -- keep them enforced there, not just configured.
- **Posting is `x-client.ts` + `x-oauth.ts`.** OAuth 1.0a is hand-rolled (~70 lines, no dependency) and pinned by X's published signature test vector in `tests/dispatch.test.ts`; if you touch the signing, that vector is what tells you it still works. Media goes through `POST /2/media/upload` -- the v1.1 `upload.twitter.com` endpoints were sunset in June 2025 -- as a single-request upload, since the chunked INIT/APPEND/FINALIZE path is only needed for video. Only the `oauth_*` params are signed: the multipart and JSON bodies are deliberately excluded, and signing them is the classic cause of an opaque 401.
- **A failed post is a skip, never a retry** (`post_failed`). A retry that succeeds after a timeout has already posted. Only 4xx counts as definite; a 5xx is filed `post_indeterminate` (`statusIsIndeterminate`), because X guarantees nothing about whether its own error fired before or after creating the post, and a definite failure releases the specimen for reuse.
- **NSFW specimens are excluded from LIVE posts only** (`LIVE_ALLOW_NSFW = false`). Not a reversal of the whole-corpus product call: X API v2 has no per-post `possibly_sensitive` field (v1.1 had one), so sensitivity can only be set account-wide. The filter runs at selection so the day picks another specimen instead of being spent on a skip. Flip it only if the posting account has sensitive-media marking enabled.
- **The drift variant is built but switched off** (`DRIFT_ENABLED = false`). Dry runs showed it either dropping the required wrong connection or emitting on-topic commentary about the trend, which rule 1 forbids outright; since caption generation never retries, leaving it on would cost or spoil a quarter of dispatches. `driftForDate` stays a pure predicate and the `--drift` dry-run flag still exercises the path, so iterating on the directive needs no code change. Turn it back on only after a dry run shows the variant holding the contract.
- Events (`dispatch.claimed` / `dispatch.sent` / `dispatch.skipped`) extend the universe canon but are **not** reduced into any projection and are **not** in the chronicle's type allowlist. Surfacing them in the feed is deliberately out of scope.

### Gallery sort + color pages

`src/lib/sort/` holds the gallery sort/shuffle strategies (clump, anti-clump, drift, tidal, drunkard's-walk, seeded-shuffle, etc.). The `/api/images` list takes `sort`/`seed` params; without them it falls back to the site-admin's `gallery_config` defaults. `/color/<hex>` (+ `/api/color/<hex>/images`) surfaces images whose extracted palette matches a hex.

### Database (`src/lib/db/`)

- Drizzle ORM on `@vercel/postgres`. Schema in `schema.ts`; migrations in `drizzle/` (`0000`-`0003`); config in `drizzle.config.ts` (reads `POSTGRES_URL`).
- Query helpers live one-file-per-concern under `src/lib/db/queries/` (images, slugs, tags, taxonomy, prompts, saved-prompts, ai-config, api-keys, embeddings, reactions, comments, reports, collections, jobs, webhooks, umap, users, about, gallery-config, palette, provenance, reprocess, stats). Route handlers and jobs import from here; **don't build Drizzle queries inline in handlers.**
- `provider_keys` (outbound BYO AI creds, encrypted) is distinct from `api_keys` (inbound personal access tokens for the public REST API; only the SHA-256 hash stored).

### PWA + SEO

`next.config.mjs` wraps the app with `@serwist/next`; the service worker source is `src/app/sw.ts` (disabled in dev). `/share-target` + `/api/share-target` handle the PWA share target (forwarding to upload). SEO surfaces: `/feed.json`, `json-ld.tsx`, sitemap/robots (`src/lib/seo/`, `src/lib/site.ts`), driven by `NEXT_PUBLIC_SITE_URL` and the optional `GOOGLE_SITE_VERIFICATION`/`BING_SITE_VERIFICATION`.

## Conventions

- **No em dashes** in code, comments, or prose. Use `--` (two hyphens). Project-wide rule from the SPEC.md bootstrap prompt; the whole codebase follows it.
- Comments explain *why*, not *what*. The schema comments and `src/app/api/images/route.ts` are good references for tone.
- Error handling at external boundaries (blob, provider, DB) returns a structured `NextResponse.json({ error }, { status })`; internal helpers throw.
- Provider/model names are persisted per-row on captions/descriptions/tags/embeddings so reprocessing can diff them against current config.
- New admin endpoints: add an explicit in-handler `isSiteAdmin`/`canEdit` gate. Middleware only guarantees "signed in" and only for its matcher paths.

## Known judgment calls

- Captions/descriptions are **one JSON call returning 3 variants** per field, not 3 calls. `{{variant_number}}` is wired but unused.
- Manual caption is **variant 4** (`locked=true, isSlugSource=true`), not a replacement for an AI variant.
- Random caption/description **selection is server-side per request** -- no stability across refreshes. Don't add client caching that fights this.
- No `sharp`/native image libs. EXIF + `takenAt` from `exifr`, palette from `node-vibrant`. `images.width`/`height` exist but stay null -- nothing probes dimensions.
- Embedding + enrichment are **best-effort and async**: a failed model call leaves the row usable (placeholder slug / null embedding) and eligible for `/admin/reprocess` or `scripts/backfill-embeddings.ts`. A failed embedding never fails the upload.
- **GPS EXIF is stripped before persisting** (`image-meta.ts`). `images.exif` is returned by the public list endpoint, so re-adding GPS means publishing GPS -- needs a private column or server-side redaction first.
- Per-user BYO keys fall back to env-var keys when a user has no `provider_keys` row -- so the bootstrap admin keeps working purely on `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`.

## Required environment

Beyond the README's list, the current code also reads: `CRON_SECRET` (gates `/api/cron/jobs`; the queue does nothing without it), `NEXT_PUBLIC_SITE_URL` (SEO/canonical origin), and optionally `GOOGLE_SITE_VERIFICATION`/`BING_SITE_VERIFICATION`. `AUTH_SECRET` is doubly load-bearing now: Auth.js session signing **and** the PBKDF2 root for provider-key encryption.
