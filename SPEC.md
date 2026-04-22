# pix.fish

A personal image gallery with AI enrichment, semantic exploration, and public engagement. Single owner, single uploader, open to the world for reactions.

## What it is

You post pictures. AI enriches them – three captions, three descriptions, auto-tags drawn from a curated taxonomy, and embeddings. Captions rotate on display. One becomes the permalink slug. The gallery is searchable, filterable, and semantically navigable. Visitors can react and comment. You can generate hybrid prompts by selecting pairs of images by similarity or dissimilarity, feeding your next creative move.

## Core features

### Ownership & auth

- OAuth via GitHub only, gated to an owner allow-list (env var of GitHub usernames/IDs)
- Personal Access Tokens (PATs) for API access, managed from the admin UI
- Public read (images, captions, comments, reactions)
- Write (upload, edit, delete, moderate) gated to owner only

### Upload paths

- Drag/drop + file picker in web UI
- Paste from clipboard
- `POST /api/images` with PAT for scripts
- PWA share target (post directly from phone share sheet)
- Bulk upload (multiple files at once)

### AI enrichment pipeline (async, WebSocket-driven)

On upload, image is stored immediately, a job is queued, and enrichment streams back over WebSocket as each stage completes:

1. **Captions x3** – three short captions generated per image. One is randomly selected for display on each page load. The first generated caption is auto-slugified for the permalink. Owner can reassign which caption is the slug or edit the slug directly.
1. **Descriptions x3** – three longer-form descriptions. Randomly displayed like captions.
1. **Tags** – structured tags drawn from the curated taxonomy (general/structural) plus free-form specific tags describing the image content. See “Tag taxonomy” below.
1. **Embedding** – image+text embedding stored in pgvector.
1. **Color palette** – dominant colors, extracted locally.
1. **EXIF metadata** – preserved by default, strippable per-image.

### Editable prompts (stored in DB)

All AI prompts are stored in a `prompts` table keyed by function (caption, description, tags). The admin UI exposes a textarea for each prompt template. The enrichment pipeline reads prompts from the DB at execution time – never hardcoded.

Prompt templates support placeholders:

- `{{tag_taxonomy}}` – injects the current tag taxonomy list
- `{{existing_caption}}` – if the owner provided a manual caption at upload
- `{{variant_number}}` – which of the 3 variants is being generated (for prompt variation)

This means you can tune the AI’s voice, style, and focus without redeploying.

### Tag taxonomy

A curated list of ~100-200 general/structural tags stored in the DB (`tag_taxonomy` table). These are injected into the tag generation prompt so the AI uses consistent vocabulary for broad categories alongside free-form specific tags.

Example categories in the taxonomy:

- **Medium**: photograph, illustration, cartoon, painting, screenshot, render, collage, sketch
- **Color**: color, black-and-white, monochrome, sepia, high-contrast, muted, vibrant, pastel, neon
- **Style**: portrait, landscape, macro, aerial, street, abstract, surreal, minimalist, documentary, candid
- **Mood**: dark, bright, moody, playful, eerie, calm, chaotic, nostalgic, melancholic, dreamy
- **Content**: people, animal, nature, urban, food, text, architecture, interior, vehicle, sky, water
- **Technical**: shallow-dof, long-exposure, film-grain, digital, flash, natural-light, studio-lit, HDR

The taxonomy is editable from the admin UI (add/remove/reorder). When the tag prompt runs, the current taxonomy is serialized and injected via `{{tag_taxonomy}}`.

AI-generated tags are a mix of taxonomy matches (structural) + free-form tags (specific to the image content). Both types live in the same `tags` table with a `source` flag.

### Permalinks

Each image gets a permalink at `pix.fish/<slug>` where the slug is derived from one of its three captions:

- Default: first caption generated, slugified (lowercase, spaces to dashes, special chars stripped)
- Owner can reassign to any of the three captions or edit the slug manually
- Collision handling: append `-2`, `-3`, etc.
- Old slugs redirect (301) if changed – slug history tracked

The permalink page shows: full image, active caption, active description, all tags, reactions, comments, nav bar, timestamp, EXIF (if present), color palette.

### Manual override

- Add your own caption at upload time (becomes a 4th option or overrides one)
- Edit any caption, description, tag at any time
- Lock any field to prevent re-enrichment overwriting it

### Browsing & filtering

- Tag cloud (sized by frequency)
- Multi-tag filter (AND/OR toggle)
- Date filtering (timeline scrubber)
- Sort: newest, oldest, most-liked, most-commented, random
- Keyboard navigation (j/k next/prev image, / to search, ? for help)

### Semantic exploration

- **Search**: natural-language query, ranked by embedding similarity across captions + image embeddings
- **Embedding map**: 2D UMAP/t-SNE projection of your entire collection, zoomable and pannable, click a point to open. This is the centerpiece feature.
- **Similar / dissimilar pairs**: select 2+ images, get similarity score and a generated hybrid prompt describing what an image blending them might look like
- **“More like this”**: on any image page, show 6 nearest neighbors by embedding

### Public engagement

- Thumbs up / thumbs down (anonymous, rate-limited by IP+fingerprint)
- Comments (anonymous with display name, hCaptcha, honeypot, rate-limited)
- Moderation queue (owner approves before public display, or auto-approve with post-hoc delete)
- Report button (flags for owner review)

### Sharing & discovery

- OpenGraph + Twitter card metadata per image (good-looking shares)
- RSS/Atom feed (subscribe to new posts)
- Per-image permalink (`pix.fish/<slug>`)
- “Share” button copies link

### Admin & operations

- Prompt editor UI (edit caption/description/tags prompts, see current templates)
- Tag taxonomy editor (add/remove/reorder structural tags)
- API key management UI (create, label, revoke, see last-used)
- Provider routing config (which provider for each AI function)
- Webhook outbox (fires on upload, enrichment-complete, comment-posted)
- Reprocessing jobs: re-enrich N images with a different provider/model/prompt
- Stats dashboard: uploads over time, tag frequency, top-reacted, provider cost estimate
- Full backup export: ZIP of originals + JSON of all metadata

## Architecture

### Stack

- **Framework**: Next.js 14 (App Router, TypeScript, Tailwind, shadcn/ui)
- **Hosting**: Vercel
- **DB**: Neon Postgres via Vercel integration, with pgvector
- **ORM**: Drizzle
- **Image storage**: Vercel Blob
- **Auth**: Auth.js (NextAuth) with GitHub provider
- **Async/realtime**: Ably for WebSocket
- **Queue**: Upstash QStash for fan-out, or Vercel Cron for simple jobs
- **AI providers**: pluggable adapter layer for OpenAI + Anthropic (+ future)

### Provider abstraction

One interface, N implementations. Each AI call type has a configurable provider routed at request time:

```ts
interface AIProvider {
  caption(image: Buffer, prompt: string, opts?: CaptionOpts): Promise<string>
  describe(image: Buffer, prompt: string): Promise<string>
  tag(image: Buffer, prompt: string): Promise<string[]>
  embed(input: string | Buffer): Promise<number[]>
}
```

Config starts in `ai_config` table. Owner can swap providers per-field at runtime from admin UI. Reprocessing job walks the image table and re-enriches any field where the provider or prompt changed.

Note: prompts are passed INTO the provider – the provider doesn’t own the prompt. Prompts live in the `prompts` table and are resolved before the provider call.

### Data model

```sql
-- core
images (
  id serial primary key,
  slug text unique not null,
  slug_history text[],
  blob_url text not null,
  blob_key text not null,
  mime text,
  width int,
  height int,
  taken_at timestamptz,
  uploaded_at timestamptz default now(),
  owner_id text not null,
  exif jsonb,
  palette text[],
  manual_caption text
)

captions (
  id serial primary key,
  image_id int references images(id),
  variant int not null,             -- 1, 2, or 3
  text text not null,
  provider text,
  model text,
  is_slug_source boolean default false,
  locked boolean default false,
  created_at timestamptz default now()
)

descriptions (
  id serial primary key,
  image_id int references images(id),
  variant int not null,             -- 1, 2, or 3
  text text not null,
  provider text,
  model text,
  locked boolean default false,
  created_at timestamptz default now()
)

tags (
  id serial primary key,
  image_id int references images(id),
  tag text not null,
  confidence float,
  source text not null,             -- 'taxonomy' or 'freeform'
  provider text,
  model text,
  unique(image_id, tag)
)

tag_taxonomy (
  id serial primary key,
  tag text unique not null,
  category text,
  sort_order int
)

embeddings (
  id serial primary key,
  image_id int references images(id),
  kind text not null,               -- 'image', 'caption', 'combined'
  provider text,
  model text,
  vec vector(1536)
)

prompts (
  id serial primary key,
  key text unique not null,         -- 'caption', 'description', 'tags'
  template text not null,
  version int default 1,
  updated_at timestamptz default now()
)

-- engagement
reactions (
  id serial primary key,
  image_id int references images(id),
  kind text not null,               -- 'up' or 'down'
  ip_hash text,
  fingerprint text,
  created_at timestamptz default now()
)

comments (
  id serial primary key,
  image_id int references images(id),
  author_name text,
  body text not null,
  status text default 'pending',
  ip_hash text,
  created_at timestamptz default now()
)

reports (
  id serial primary key,
  target_type text,
  target_id int,
  reason text,
  created_at timestamptz default now()
)

-- ops
api_keys (
  id serial primary key,
  owner_id text not null,
  label text,
  key_hash text unique not null,
  last_used_at timestamptz,
  created_at timestamptz default now()
)

webhooks (
  id serial primary key,
  url text not null,
  events text[],
  secret text,
  active boolean default true
)

jobs (
  id serial primary key,
  kind text not null,
  image_id int references images(id),
  status text default 'pending',
  attempts int default 0,
  payload jsonb,
  error text,
  created_at timestamptz default now(),
  finished_at timestamptz
)

ai_config (
  key text primary key,
  value jsonb
)

saved_prompts (
  id serial primary key,
  kind text,
  image_ids int[],
  prompt text not null,
  created_at timestamptz default now()
)
```

### API surface

```
# Public
GET  /api/images                       list with filters, pagination
GET  /api/images/:slug                 detail (captions, descriptions, tags, reactions)
GET  /api/tags                         tag cloud data
GET  /api/search?q=...                 semantic search
POST /api/images/:slug/reactions       anonymous thumb up/down
POST /api/images/:slug/comments        anonymous comment (hCaptcha)
GET  /api/feed.xml                     RSS/Atom

# Owner (Bearer PAT or session)
POST   /api/images                     upload (multipart or URL, optional manual_caption)
PATCH  /api/images/:slug               edit caption/description/tags/locks/slug
DELETE /api/images/:slug
POST   /api/images/:slug/reprocess     trigger re-enrichment

POST   /api/prompts/hybrid             body: { imageIds, mode: "similar"|"dissimilar" }
GET    /api/embedding-map              UMAP coords for all images

GET    /api/prompts                    list editable prompt templates
PATCH  /api/prompts/:key               update a prompt template

GET    /api/taxonomy                   list tag taxonomy
POST   /api/taxonomy                   add tag
DELETE /api/taxonomy/:id               remove tag

POST   /api/api-keys                   create PAT
DELETE /api/api-keys/:id

GET    /api/comments?status=pending    moderation queue
PATCH  /api/comments/:id               approve/reject

POST   /api/jobs/reprocess             bulk re-enrichment
GET    /api/stats
```

### WebSocket events

Client subscribes to `image:<id>` channel after upload. Server publishes:

```
{ event: "caption.ready",      imageId, variant, text }
{ event: "description.ready",  imageId, variant, text }
{ event: "tags.ready",         imageId, tags: [...] }
{ event: "embedding.ready",    imageId }
{ event: "palette.ready",      imageId, colors: [...] }
{ event: "slug.assigned",      imageId, slug }
{ event: "enrichment.done",    imageId }
{ event: "enrichment.failed",  imageId, stage, error }
```

## Open decisions

1. **Embedding dimensions**: OpenAI `text-embedding-3-small` (1536) vs `3-large` (3072). Start with 1536, index with HNSW in pgvector.
1. **Image embedding model**: CLIP via Replicate? Or caption-text-only embeddings for MVP, add image embeddings later?
1. **UMAP recompute trigger**: recompute on upload (expensive) vs nightly cron (stale) vs on-demand cached.
1. **Caption variant strategy**: same prompt run 3 times with temperature, or 3 distinct sub-prompts (e.g. “poetic”, “literal”, “witty”)?
1. **Comment identity**: fully anonymous with display name, or require email (unverified)?

## Build phases

### Phase 1 – Foundation (walking skeleton)

- Next.js + Vercel + Neon + Blob + GitHub OAuth + owner gate
- Upload, store, display grid
- Prompts table seeded with default caption/description/tags prompts
- Tag taxonomy table seeded with ~120 structural tags
- Synchronous caption x3 + description x3 + tags via one provider (Anthropic)
- Slug generation from first caption
- Public view, manual caption/description edit
- Image detail page at `pix.fish/<slug>`
- Dark gallery aesthetic

### Phase 2 – Async + realtime

- Job queue, Ably WebSocket, progressive enrichment UI
- Embeddings into pgvector
- Semantic search endpoint + UI
- Color palette + EXIF extraction

### Phase 3 – Engagement + admin

- Reactions, comments, hCaptcha, moderation queue
- RSS, OpenGraph
- PAT management + API docs
- Prompt editor UI
- Tag taxonomy editor UI
- Provider routing config UI

### Phase 4 – Killer features

- Embedding map (UMAP, 2D canvas)
- Hybrid prompt generator + saved prompts
- Provider swap + reprocessing jobs
- Webhooks
- PWA + share target
- Stats dashboard
- Full backup export

-----

## Appendix: Claude Code bootstrap prompt

Paste this into Claude Code at the root of an empty repo with this spec file present.

```
I'm building pix.fish -- a personal image gallery with AI enrichment. I'm the
only user who uploads; the rest of the world can view, react, and comment.

Read SPEC.md (attached or in repo root) in full before starting.

Bootstrap Phase 1 (Foundation) now:

1. Scaffold a Next.js 14 App Router project with TypeScript, Tailwind, and
   shadcn/ui. Initialize git, add a sensible .gitignore, set up pnpm.

2. Wire Vercel Blob for image storage and Neon Postgres via @vercel/postgres.
   Add pgvector extension migration. Use drizzle-orm for schema + queries.

3. Implement OAuth via Auth.js (NextAuth) with GitHub provider only. Gate
   write access to an OWNER_GITHUB_ID env var. Public read is unauthenticated.

4. Build the data model from SPEC.md "Data model" section using drizzle.
   For Phase 1 implement: images, captions, descriptions, tags, tag_taxonomy,
   prompts, api_keys. Leave stubs/comments for the rest.

5. Seed the prompts table with three default prompt templates:
   - "caption": generates 3 short captions for a photo. Each should be
     distinct in voice -- one literal, one poetic, one witty. Under 10 words
     each. Template uses {{variant_number}} and {{existing_caption}}.
   - "description": generates 3 longer descriptions (2-3 sentences each).
     Same variant strategy. Template uses {{variant_number}}.
   - "tags": generates tags for the image. Template uses {{tag_taxonomy}}
     to inject the structural tag list. Output should be a mix of taxonomy
     matches and free-form specific tags. Structured JSON output.

6. Seed the tag_taxonomy table with ~120 tags across categories: medium,
   color, style, mood, content, technical. See SPEC.md for examples.

7. Build an AI provider abstraction in /lib/ai/ with an AIProvider interface
   and two implementations: AnthropicProvider and OpenAIProvider. For Phase 1,
   implement .caption(), .describe(), and .tag() (all vision calls). The
   provider receives the prompt as an argument -- it does NOT own prompts.
   Read ANTHROPIC_API_KEY and OPENAI_API_KEY from env. Provider selection
   is a simple config in /lib/ai/config.ts (move to DB later).

8. Prompt resolution layer in /lib/prompts/: reads prompt templates from DB,
   resolves {{placeholders}} (tag_taxonomy, existing_caption, variant_number),
   returns the final prompt string to pass to the provider.

9. API routes (Phase 1 subset):
   - POST /api/images -- owner only, multipart upload, stores blob, creates
     image row, runs SYNCHRONOUS enrichment (caption x3, description x3,
     tags), generates slug from first caption, returns the full record.
   - GET /api/images -- public, paginated, filterable by tag(s).
   - GET /api/images/:slug -- public, full detail.
   - PATCH /api/images/:slug -- owner only, edit captions/descriptions/tags/
     locks/slug.

10. Slug generation: take the first caption, lowercase, replace spaces with
    dashes, strip special chars, truncate to 80 chars, handle collisions
    with -2, -3, etc. Store slug_history for redirects.

11. UI:
    - Home: grid of images, each showing a randomly-selected caption. Tag
      cloud in sidebar or top. Tag filter chips. Newest-first default.
    - Upload page (owner only): drag/drop zone, optional manual caption
      field, shows enrichment results inline as they complete.
    - Image detail page at /<slug>: full image, randomly-selected caption
      + description, all tags as chips, timestamp, nav bar. Placeholder
      areas for reactions/comments (wired in Phase 3).
    - Admin layout with sidebar nav (upload, prompts, taxonomy, keys).
    - Dark aesthetic -- muted background, subtle grain, serif display font
      for captions, mono for tags. Late-night gallery, not corporate SaaS.

12. Write a README.md with local dev instructions, env var list, and
    deployment steps for Vercel + Neon.

Constraints:
- No em dashes anywhere in generated code, comments, or prose. Use -- instead.
- Keep it minimal. Don't add features beyond Phase 1.
- All AI calls go through the provider abstraction. No direct vendor SDK
  calls in route handlers or components.
- All AI prompts are read from the DB via the prompt resolution layer.
  Never hardcode prompt text in provider code.
- Write small, testable modules. Prefer composition over frameworks.

When Phase 1 is done, show me the file tree, the key commands to run it
locally, and call out anything ambiguous or where you made a judgment call
I should know about. Do not start Phase 2 until I say so.
```
