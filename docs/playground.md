# Inspiration playground

`/admin/play` is a prompt-generation jukebox built on top of the pix.fish corpus. Phase 1 ships three stacked sections: skeleton (mined grammar), dice (constraint cards), clipboard (multi-model dialects).

## Decisions

### Grammar derivation: hybrid (POS + optional LLM cleanup)

The brief asked for a hybrid POS + LLM approach. The shipped path:

1. `scripts/derive-grammar.ts` walks every caption and every description-first-sentence for the site admin's images. It POS-tags each text with [`compromise`](https://github.com/spencermountain/compromise) (pure-JS, MIT) and replaces consecutive `#Noun`/`#Verb`/`#Adjective` spans with `[noun]`/`[verb]`/`[adjective]` placeholders, pooling the raw spans as fillers under each slot type.
2. Templates and fillers are frequency-counted and bulk-inserted into `grammar_slots` + `grammar_fillers` (per-owner, scoped on `owner_id`).
3. **Optional**: passing `--llm` calls the owner's configured `captions` provider once with the top templates and top fillers, asking the model for friendlier slot names ("mundane_noun" instead of "noun") and a curated filler list. Falls back to the raw POS output on any failure -- the script never blocks on the LLM step.

Why hybrid and not pure-LLM: keeping the POS pass at the core means every owner can derive a grammar even without a BYO key, and re-runs are deterministic. The LLM step is a quality-of-life pass over an already-working artifact.

Why hybrid and not pure-POS: with bare POS slots, every `[noun]` slot has the same filler pool. The LLM step lets the artifact reflect *how* slots differ semantically across templates ("a man waits at the window" vs "the fish reaches the gallery") without the script having to do positional disambiguation by itself.

### Storage: new DB tables

`grammar_slots`, `grammar_fillers`, `constraint_cards` live in Postgres (see `src/lib/db/schema.ts`). Per-owner ownership on grammar tables; constraint cards are global like `tag_taxonomy`. Re-running `derive-grammar.ts` deletes the owner's previous rows in a single statement (`clearGrammar`) and bulk-inserts the new ones, so the artifact is always a clean snapshot.

Why DB and not JSON in `data/`: phase 2 will want admin editability without redeploy. Putting it in the DB now is cheap and avoids a migration later. The seed script handles constraint cards idempotently; the derive script handles grammar idempotently.

### `/admin/play` layout: single page, stacked sections

`/admin/play/page.tsx` is the server shell (gates on `isSiteAdmin`, loads grammar-presence flag + card counts). `_components/playground-client.tsx` is the only client component:

- **Skeleton**: re-roll button, list of N filled templates. Each filled slot is a tappable chip; tapping a chip pins that slot's filler across the next re-roll. The pin map is global to the section, not per-prompt, so a single set of pins steers every roll.
- **Dice**: category toggles (with counts), roll button, rolled cards. Tapping a card opts it into the "active modifiers" list that flows into the clipboard preview.
- **Clipboard**: shows the active skeleton + active modifiers as a canonical prompt, then each of 5 dialects (Midjourney v7, Flux, SDXL, DALL-E 3, Sora) with a one-click copy button.

Pure transforms only at runtime in this phase: skeleton generation is weighted-random JS over the loaded grammar, dice is Fisher-Yates over the loaded card pool, dialects are deterministic string transforms. No model calls happen on `/admin/play` itself; the model is touched once during `derive-grammar.ts --llm`.

## Phase 2: dials and surprise (embedding-space features)

Phase 2 adds four tabs to `/admin/play`, all of which call the configured text
provider (the `descriptions` field, since these produce prose prompts) and return
candidate image-generation prompts rendered through the same dialect clipboard.

### 2.1 Vibe equalizer

Sliders for interpretable axes of the gallery. Moving a slider, debounced 500ms,
asks the model for prompts steered toward those coordinates, with the mined grammar
injected as a stylistic constraint (`{{grammar_style}}`).

**Axis derivation is a decision gate.** `scripts/vibe-axes.ts` produces output for all
three candidate approaches so the owner can compare interpretability before committing
one to the `vibe_axes` table:

```sh
bun scripts/vibe-axes.ts                 # prints a JSON comparison of all three
bun scripts/vibe-axes.ts --write tag     # persist the hand-picked tag-cluster axes
bun scripts/vibe-axes.ts --write pca     # persist principal components
bun scripts/vibe-axes.ts --write kmeans  # persist LLM-named embedding clusters
```

- **tag** -- 8 hand-picked bipolar axes (absurdity, dread, saturation, warmth, nature vs
  built, stillness, intimacy, brightness) scored from the tag taxonomy. Fast, obviously
  interpretable, but blind to latent structure.
- **pca** -- principal components of the caption embeddings via the n x n Gram trick
  (no 1536-dim eigenvectors materialised). Mathematically clean; poles auto-labelled by
  the dominant tag at each end, which is where interpretability gets shaky.
- **kmeans** -- k clusters of the embeddings, each named by the LLM, each becoming a
  unipolar "how much like this vibe" slider.

> Comparison data: this remote build environment has no database or provider keys, so the
> three-way comparison must be run locally (it needs the embedded corpus). Run the
> comparison command above, paste the interesting bits here, and record which approach was
> chosen and why. Until `--write` is run the equalizer tab shows an empty state with the
> command to run.

The `equalizer` prompt is DB-seeded; the endpoint is `GET /api/admin/play/equalizer?<axisKey>=0..1`.

### 2.2 Anti-prompt / surprise engine (hybrid)

`GET /api/admin/play/surprise`. Hybrid method: take the gallery centroid, pull the
farthest existing images via `searchByVector(..., { order: 'farthest' })` as far-territory
references, sample a slice of real captions as a motif sample, then have the LLM privately
enumerate the recurring motifs, invert them, and reach into the far territory while avoiding
them. The `surprise` prompt is DB-seeded.

**Centroid cache** (`src/lib/playground/centroid.ts`): lazy, in-memory. Computed from
`allCaptionVectors()` on first read, cached in a module var, invalidated from the upload
post-commit hook in `enrichment-persist.ts` right after `upsertEmbedding` (best-effort,
non-blocking, same place as the webhook emit). A serverless cold start just recomputes on
the next read -- correctness never depends on the process living forever. Chosen over a
DB-cached centroid table because the corpus is ~100 images; a recompute job would be
overkill.

### 2.3 Latent walk (metaphorical)

`GET /api/admin/play/walk?seed=<slug>&steps=N&temperature=T`. **The embedding framing is
metaphorical UX, confirmed with the owner.** There is no per-step vector math (inverting an
embedding to text is its own research problem). Instead the LLM narrates the drift: each
step feeds the previous prompt + the seed caption + a temperature-controlled mutation
instruction (`walk_step` prompt) back into the model. The UI is a seed-image browser
(gallery thumbnails) plus a step scrubber.

### 2.4 Reverse haiku

`POST /api/admin/play/reverse-haiku` with `{ haiku }`. Inverts the usual relationship:
given a haiku, imagine prompts for an image it could caption. `reverse_haiku` prompt seeded.

## Phase 3: workflow + lineage

Closes the loop: generate an image elsewhere from a pix.fish prompt, upload it back, and
the platform tracks parent -> child.

### 3.1 Remix (style transfer via prompt rewrite)

`POST /api/images/:slug/remix` with `{ idiomKey }`, gated by `canEdit`. Keeps the image's
concept, swaps the visual idiom (National Geographic, Wes Anderson, Soviet propaganda, etc).
Idioms live in the `remix_idioms` table (global, seeded; 12 to start) -- chosen over a
`data/` JSON file to match the constraint-card decision and to allow toggling an idiom off
without a redeploy. The `remix` prompt is DB-seeded. The menu sits on the image detail page,
owner-only, and reuses the dialect clipboard.

### 3.2 / 3.3 Lineage model + lineage-aware upload

`image_lineage` is a join table (multi-parent): `child_image_id`, `parent_image_id`,
`prompt_used`, `dialect_used`, indexed on both ends, unique on `(child, parent)`. The upload
route accepts optional `parents` (comma-separated owned slugs), `prompt_used`, and
`dialect_used`, resolving parent slugs to owned ids before the transaction and writing the
image row + lineage edges in **one `db.transaction`** so a partial failure leaves no orphan
edges. The upload UI adds a collapsible lineage section: a parent thumbnail multi-select, a
prompt textarea, and a dialect select.

### 3.4 Lineage visualization

`/lineage` renders a d3 force-directed parent -> child graph (`src/components/lineage-graph.tsx`).
Nodes are image thumbnails (click to open); edges carry the prompt/dialect (click to inspect).
**Owner-only by default**, with a per-user (not per-image) public toggle stored as a
`gallery_config` row (`lineage_public`), flipped from a checkbox on the page itself via
`POST /api/admin/lineage-visibility`. d3 was added as a dependency here (the rest of the repo
hand-rolls canvas viz, but force layout is fiddly to do by hand and the owner asked for a
richer graph).

## Surprises / known landmines

- **The corpus is small and uneven.** With ~107 images and ~650 caption/description rows, most extracted templates appear once. The default `MIN_TEMPLATE_FREQ = 1` keeps everything; tighten to 2 if the skeleton output feels noisy.
- **compromise tags some words ambiguously.** Words like "fish" get a `Noun|Verb` `switch` tag; the extractor lands them as Noun, which is right for most pix.fish captions but occasionally wrong. Look for `[noun] [noun]` chains where one really should have been a verb.
- **The "first sentence of description" heuristic** drops a lot of voice that lives in the second sentence. For a richer artifact, expand `loadCorpus` to take the full description; expect more noise.
- **Cards are global.** Constraint cards and Phase 3 remix idioms are both global tables (no `owner_id`), like `tag_taxonomy`. Per-user decks would need an `owner_id` column on each.
- **The gallery centroid is per-process, not per-owner.** `getGalleryCentroid()` caches one centroid for the whole corpus (the site admin's gallery). Multi-tenant surprise would need keying by owner.
- **Lineage is the site admin's only.** `/lineage` reads `getSiteAdminId()`'s graph; the public toggle is one per-user flag. A per-user `/u/<handle>/lineage` is deferred.
- **PCA poles are weakly labelled.** The pca approach labels each pole by the single most common tag among its extreme images. If two poles share a dominant tag the labels collapse; eyeball the comparison output before `--write pca`.

## Re-running

```sh
bun scripts/derive-grammar.ts            # POS-only, ~2s
bun scripts/derive-grammar.ts --llm      # POS + LLM cleanup, ~5-10s + LLM cost
bun run db:seed                          # idempotent reseed of cards (+ everything else)
```

Both scripts are safe to re-run.

## Deferred

- Admin CRUD UI for `grammar_slots` / `grammar_fillers` / `constraint_cards`. The seed + derive scripts cover Phase 1 fine.
- URL-encoded state (shareable prompt permalinks).
- Per-user grammar. Phase 1 ships the site-admin's grammar only; users running the script under a non-admin id will write rows but the playground page is owner-gated.
- LLM *semantic* per-position naming. Slots are now positional (`[noun_1]`, `[noun_2]` -- see below) so each occurrence fills independently, but the names are still type-based; an LLM pass could name them by role ("subject" vs "object").

## Fix: positional slots

Originally every `[noun]` in a template shared one filler (the sampler deduped slot names and `renderTemplate` reused the single pick), so a template with several noun slots collapsed to the same word repeated -- "the expertise stands stands black" -- and pinning a slot forced every occurrence of that type to one word. `derive-grammar.ts` now numbers each occurrence per type (`[noun_1]`, `[noun_2]`, ...); the sampler (`src/lib/playground/skeleton.ts`) treats each as a distinct slot but resolves the shared filler pool via `baseSlotName()` (strip the trailing `_<n>`). Each occurrence fills independently and is individually freezable.

Re-run `bun scripts/derive-grammar.ts` to regenerate a positional grammar -- a previously-derived flat grammar (`[noun]`) still renders, but keeps the old collapse until re-derived. Long description-derived templates (6+ slots) remain a separate quality lever: they now read with varied words but can still run on; tighten by mining captions only or capping slot count.
