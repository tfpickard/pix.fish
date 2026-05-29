# pix.fish: Inspiration Playground -- Implementation Brief

You're going to evolve pix.fish from a single-owner image gallery into a **creative imagegen prompt playground**. The existing ~107 images are the corpus / mood board. The new layer turns the platform into a generative jukebox: the owner uses it to conceive new images, then takes the resulting prompts to whatever image model they prefer.

This brief breaks the work into three phases. Before you start, read `CLAUDE.md`, `SPEC.md`, and `README.md` end to end -- they contain conventions, the AI provider abstraction, the upload pipeline, and judgment calls you must respect.

**Ask for clarification liberally.** Especially before each phase, and any time a decision has architectural tradeoffs (data model, API surface, dependency adds, UI placement). It is better to interrupt me with three questions than to ship the wrong thing. Don't proceed past a decision point on assumption. The "Ask before you code" section at the bottom lists the questions I expect you to bring back per phase, but you should add to that list as you discover ambiguity.

---

## Principles (non-negotiable)

- All vision/LLM calls go through `getProvider(field)` in `src/lib/ai/`. Never import provider SDKs directly outside `src/lib/ai/`.
- Prompts live in the DB (`prompts` table, seeded by `scripts/seed.ts`). Adding a new prompt = new seed row + placeholder support in `src/lib/prompts/resolve.ts`.
- No em dashes anywhere -- code, comments, prose, prompt strings. Use `--` (two hyphens).
- `bun` is the package manager. Do not introduce `npm`, `yarn`, or `pnpm` lockfiles.
- Comments explain *why*, not *what*. Match the tone of `src/app/api/images/route.ts`.
- Verification before declaring a phase done: `bun run typecheck && bun run lint && bun run build`, plus manual exercise in the browser.
- Migrations: `bun run db:generate` to emit, `bun run db:push` to apply. Never hand-edit generated SQL except to add idempotent extension lines like the existing `vector` enable.
- Owner gating is two layers: `middleware.ts` matcher + in-handler `isOwner()`. If you add a new admin route outside the existing matcher, add it to the matcher AND call `isOwner()` in the handler.
- Don't add Phase 4+ tables (`webhooks`, `jobs`, `ai_config`, `saved_prompts`) unless this brief explicitly asks for one of them.

---

## Phase 1: Grammar, Dice, and Clipboard (the cheap dopamine)

**Goal:** ship a `/play` route that gives the owner immediate prompt-generation utility using existing data. Minimal new model calls. Cheap to ship, instantly addictive.

### 1.1 Caption grammar mining

The existing captions have a recognizable house style. Example pattern: `[mundane noun] [absurd verb] [intimate location] at [time of day], [adjective] [object] [adverb] present`. Mine that grammar from the corpus.

- One-shot script `scripts/derive-grammar.ts` reads all captions + descriptions from the DB and produces a structured grammar artifact (slots, fillers, slot co-occurrence frequencies).
- Two viable approaches: (a) classical POS tagging + slot extraction in pure JS/TS, (b) feed the corpus to the captions provider in chunks and ask for a structured grammar back. **Bring the tradeoff to me before picking.** Cost, determinism, and quality all differ.
- Output is a versioned artifact. Propose storage: a checked-in `data/grammar.json` vs a new `grammar` DB table. I have a leaning, but tell me yours first.

### 1.2 Skeleton prompt generator

- New helper `src/lib/playground/skeleton.ts` samples a skeleton template and fills slots from the grammar with weighted random selection.
- New route `GET /api/playground/skeleton?n=N` returns N freshly generated prompts.
- UI on `/play`: a re-roll button, per-prompt copy-to-clipboard, and a "freeze slot" UX so the owner can lock in good fillers and re-roll the rest. This freeze-slot behavior is the killer interaction; design it before coding.

### 1.3 Oblique Strategies dice

Brian Eno meets prompt engineering. Constraint cards, not full prompts.

- Seed 50-100 constraint cards across categories: `medium`, `subject_archetype`, `modifier`, `mood`, `idiom`, `composition`. Examples: "render as Soviet socialist realism", "subject is wrong scale", "everyone is wearing the same shoes".
- Storage: same decision pattern as grammar -- file vs table. Propose.
- `GET /api/playground/dice?n=N&categories=...` returns rolled constraint sets.
- UI section on `/play` with category toggles, a roll button, and the ability to "merge into current skeleton" so dice + grammar combine.

### 1.4 Multi-model prompt clipboard

- `src/lib/playground/dialects.ts` takes a canonical prompt object and emits versions tuned for: Midjourney v7, Flux (verbose natural language), SDXL (booru-style tags), DALL-E 3 (narrative), Sora (cinematic). Each dialect is a pure transform function. No model calls.
- UI: per-prompt copy menu listing each dialect, one click to clipboard. Show a tiny preview of how the dialect mutates the prompt.

### 1.5 Auth gating

- `/play` and all `/api/playground/*` routes are owner-only.
- Extend the `middleware.ts` matcher. Add `isOwner()` checks inside each handler.

### Phase 1 deliverables (review gate)

- Grammar artifact derived and committed (or migration applied).
- `/play` page with skeleton + dice + dialect copy functional end to end.
- `bun run typecheck && bun run lint && bun run build` clean.
- A short writeup in `docs/playground.md` covering: the grammar derivation method chosen and why, the storage decision, and any surprising data-quality issues found in the corpus.

**Stop here. Demo Phase 1 to me. Do not start Phase 2 without sign-off.**

---

## Phase 2: Dials and Surprise (the embedding-space features)

**Goal:** turn the embedding space into a steerable instrument. This phase has the most interesting modeling decisions; expect a real conversation before any code.

### 2.1 Vibe equalizer

The owner gets sliders for 6-10 interpretable dimensions of the gallery. Move a slider, an LLM generates a prompt steered toward those coordinates.

Three candidate approaches for deriving the axes, all viable, all different:

- **Hand-picked tag-cluster axes** -- fast, opinionated, axes are obviously interpretable (e.g. "absurdity", "dread", "saturation"). Risk: misses latent structure.
- **PCA on caption embeddings** -- mathematically clean, but principal components in 1536d are not guaranteed to be human-interpretable.
- **k-means clusters on embeddings, LLM-named** -- clusters are interpretable post-hoc, but mapping cluster membership to slider values is non-trivial.

Build `scripts/vibe-axes.ts` that produces output for **all three** approaches over the current corpus, so I can compare before we commit. Don't pick blind.

- Persist the chosen axes as `data/vibe-axes.json` (or DB; propose).
- `GET /api/playground/equalizer?absurdity=0.7&dread=0.3&...` returns a steered prompt. Implementation: build a steering meta-prompt that names the axes and target values, then call the captions provider with the grammar artifact as a stylistic constraint.
- UI: sliders on `/play`, live regeneration with debouncing (probably 500ms). Show the current prompt and a "freeze + reroll" button.

### 2.2 Anti-prompt / surprise engine

- Compute gallery centroid in caption-embedding space. Cache it. Invalidate on upload via the existing post-transaction hook in `src/app/api/images/route.ts`. **Do not block uploads on centroid recomputation -- it goes after the transaction commit, same pattern as embedding writes.**
- `GET /api/playground/surprise` returns prompts intended to be maximally distant from the centroid.
- Method options (discuss before implementing):
  - Ask the LLM to enumerate the gallery's recurring motifs, then explicitly invert them.
  - Sample distant points in embedding space and ask the LLM to imagine prompts that would land there.
  - Hybrid -- enumerate motifs, then sample far points constrained to *not* match those motifs.

### 2.3 Latent walk

`GET /api/playground/walk?seed=<slug>&steps=N&temperature=T` returns a sequence of prompts drifting from the seed image's region.

Caveat: random walks in 1536d are not visualization-friendly, and inverting embeddings to text is its own research problem. Don't try. The LLM should narrate the walk: at each step, take the previous prompt + the seed image's caption + a temperature-controlled mutation instruction, generate the next prompt. The "embedding" framing is metaphorical UX, not actual vector math at each step. **Confirm this interpretation with me before coding.**

UI: pick a seed image from a small browser (reuse gallery thumbnails), step through the walk with a scrubber, copy any prompt along the path.

### 2.4 Reverse haiku

You already commission haiku titles for the gallery. Invert the relationship.

- New prompt template seeded into the `prompts` table, key `reverse_haiku`.
- `POST /api/playground/reverse-haiku` takes a haiku string, returns a prompt for an image that haiku could caption.
- UI panel on `/play`: textarea, generate button, output prompt with the dialect copy controls.

### Phase 2 deliverables (review gate)

- All four features behind `/play` tabs or sections.
- Axis-derivation decision documented in `docs/playground.md` with the comparison data from `scripts/vibe-axes.ts`.
- Centroid cache + invalidation wired into the upload path, non-blocking.
- `bun run typecheck && bun run lint && bun run build` clean.

**Stop here. Demo Phase 2. Sign-off before Phase 3.**

---

## Phase 3: Workflow + Lineage (closing the loop)

**Goal:** when the owner generates an image elsewhere from a pix.fish prompt and uploads it back, the platform tracks parent -> child. The gallery becomes a visualized creative lineage.

### 3.1 Style transfer via prompt rewrite

- On each image page (`/[slug]`), add a "remix this concept as..." menu visible to the owner only.
- Seed a list of idioms: National Geographic, Wes Anderson still, Soviet propaganda poster, 1990s SNES box art, Le Guin paperback cover, Diane Arbus, etc. Storage decision again -- file vs table. Propose.
- `POST /api/images/:slug/remix` (owner-only) takes an idiom key, returns a rewritten prompt. The LLM keeps the *concept* and swaps the *visual idiom*.
- Output uses the dialect copy controls from Phase 1.

### 3.2 Genealogy data model

- New table `image_lineage`. Bring the column set to me before generating the migration. Starting proposal: `id`, `child_image_id`, `parent_image_id`, `prompt_used`, `dialect_used`, `created_at`. Many-to-many: an image can have multiple parents (the remix engine fuses).
- Indexes on `child_image_id` and `parent_image_id` because the graph queries hit both directions.
- Migration via the standard `bun run db:generate` + `db:push` flow.

### 3.3 Lineage-aware upload

- Extend `POST /api/images` to optionally accept `parents: string[]` (parent slugs) and `prompt_used: string`. Persist into `image_lineage` **inside the existing transaction** so a partial failure leaves no orphans.
- Owner upload UI: a multi-select referencing existing images by thumbnail + caption, plus a textarea for the prompt that produced the upload.

### 3.4 Lineage visualization

- New page `/lineage`. Directed graph, parent -> child.
- Library: D3 force-directed is fine and dependency-light. If you want to propose an alternative (e.g. vis-network, sigma.js) bring the tradeoff first.
- Click a node: opens the image. Click an edge: shows the prompt used and the dialect.
- **Public vs owner-only?** Bring this question to me. There's a reasonable case for either.

### 3.5 Wrap up

- Update `SPEC.md` with a Phase 5 entry covering the playground and lineage.
- Update `README.md` "Judgment calls you should know about" with anything new and non-obvious from this work.
- Add an `Inspiration playground` paragraph to README's overview.

### Phase 3 deliverables (review gate)

- Remix menu + lineage tracking + `/lineage` page all functional.
- SPEC.md and README.md updated.
- `bun run typecheck && bun run lint && bun run build` clean.

---

## Ask before you code

These are the questions I expect you to surface before each phase. **Add to this list any time you discover ambiguity.** Do not proceed past a decision point on assumption.

**Phase 1**
- Grammar mining approach: POS-based, LLM-extracted, or hybrid? Bring the cost/quality/determinism tradeoff.
- Storage for grammar + constraints: JSON files in `data/` vs new DB tables? Pros, cons, your recommendation.
- `/play` structure: single page with sections vs sub-routes (`/play/skeleton`, `/play/dice`)? What does the freeze-slot UX prefer?

**Phase 2**
- Axis derivation: which of the three approaches, or a combination? Show me the comparison output from `scripts/vibe-axes.ts` first.
- Centroid recomputation: every upload vs periodic vs lazy on first read after dirty? Volume is low; pick the simplest correct option.
- Latent walk narration: confirm the "metaphorical embedding" interpretation before implementing.
- Surprise engine method: motif inversion, distant-point sampling, or hybrid?

**Phase 3**
- Lineage data model: single parent vs multi-parent, edge metadata, indexes.
- `/lineage` page: public read vs owner-only?
- Graph rendering library: D3 default, or do you want to propose something else?

---

## How to work

- One phase at a time. Demo each before starting the next.
- Small commits. Conventional commit messages match the existing repo style.
- If you find yourself wanting to refactor something outside the scope of the current phase, write it down in `docs/playground.md` under "deferred" and keep moving.
- When something seems off in the existing codebase (a bug, a missing index, a stale comment), surface it as a question rather than silently fixing it.
- The bar is "would the owner of pix.fish be proud to ship this". Not "it works in dev". Not "tests pass" (there are none yet). Manual exercise the feature end to end before claiming it's done.

Start by reading the three core docs and confirming back to me: (1) you understand the existing AI provider abstraction and the upload pipeline, and (2) your initial Phase 1 questions. Then we'll iterate from there.
