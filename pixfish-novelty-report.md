# pix.fish novelty recon report

Two-track feature planning. **Track A** plans the four already-committed concepts against the real
schema, pipeline, and routes. **Track B** proposes novel features that could not be built without this
corpus, this latent space, and this fictional frame. This is a planning document. No code, schema, or
data was changed producing it (`git status` shows only this file).

A note before anything else, because it changes the assumptions in the task brief:

- **The universe layer is not "planned." It is built and running.** `events` (append-only canon),
  `clerks`, `districts`, `specimens`, `cross_references`, `lore_fragments` all exist and are populated;
  there is a Phase-2 evolution loop (`salience.ts` -> `universe.tick` -> `universe.amend`) driven by
  `/api/cron/universe`, and a public canon feed at `/chronicle`. Clerks already write conflicting
  dossiers that cite kNN neighbors. Several Track B ideas therefore build on canon that already ships,
  not on a hypothetical.
- **"Offline Python compute" is actually offline bun/TypeScript compute** -- `scripts/*.ts` run under
  `bun`, plus the DB-backed job queue drained by `/api/cron/jobs`. The "nightly compute is free"
  assumption holds; the language is just TS, not Python. Nothing in this report needs Python.
- **Corpus size is small** (`/map` reports 204 points, 112 embedded at last projection). Every idea here
  assumes a few hundred images, not a few hundred thousand. That is a feature: geometry over a small
  coherent corpus is legible in a way it never is at platform scale.
- CLAUDE.md and SPEC.md are stale relative to the code. Where this report cites a file/line/route it was
  read directly this session; the code is authoritative.

---

## Phase 1 -- Data map

### What exists per image

An image is `images` (one row) plus a constellation of referencing tables. Line refs are
`src/lib/db/schema.ts`.

| Data | Where | Notes |
|---|---|---|
| Blob + identity | `images` (L65) | `slug`, `slugHistory[]` (GIN, redirects), `blobUrl/Key`, `mime`, `width/height` (always null -- no `sharp`), `ownerId` |
| Time | `images` | `takenAt` (EXIF), `uploadedAt`, `archivedAt` (soft-hide, recoverable) |
| Color | `images.palette text[]` | 5 hex colors (node-vibrant). Drives `rainbow` sort + `/color/[hex]` |
| EXIF | `images.exif jsonb` | GPS stripped before persist. Returned by public list API |
| Caption registers | `captions` (L124) | `variant` 1-3 AI + 4 manual (`locked`, `isSlugSource`), factual->poetic, `provider`/`model` per row |
| Long-form registers | `descriptions` (L144) | same shape as captions |
| Tags | `tags` (L163) + `tagTaxonomy` (L182) | `confidence`, `source` (taxonomy/freeform) |
| NSFW | `images.isNsfw` + `nsfwSource` | server-gated at query layer via `pf_show_nsfw` cookie |
| Surprisal | `images.surprisal real` (L96) | entropy = centroid-distance blended with tag-rarity. Nightly `compute-entropy.ts`. Drives `surprising-first` |
| Lineage | `images.generation` + `imageLineage` (L699) | breeding parentage (many parents); `/lineage` d3 graph |
| Basement | `images.basement` (L103) | second server-gated hidden surface |
| Derivatives | `images.derivatives jsonb` (L108) | WebP ladder `[{w,url}]`, offline `generate-derivatives.ts` |
| Caption embedding | `embeddings` (L255) | `kind='caption'`, 1536d (`text-embedding-3-small`), only the slug-source caption is embedded today |
| kNN edges | `knnEdges` (L773) | directed, cosine `dist`, K=10, both directions. Built by `knn.rebuild` / `build-knn.ts` |
| Cross-references | `crossReferences` (L891) | canon's formal record of kNN links, filed at intake |
| Reactions | `reactions` (L298) | anon up/down, one per (image, ip_hash) |
| Comments | `comments` (L322) | moderated; guest geo captured |
| Reports | `reports` (L355) | image/comment flags |
| Shelves | `collections` + `collectionItems` (L372) | anonymous shareable |
| Attention (dwell) | `imageAttention` (L796) | decayed dwell, 3-day half-life, PII-free. Only the `drift` sorts read it |
| Taste | `tasteVotes` (L1075) | pairwise this-or-that votes -> "most magnetic" leaderboard |
| Specimen / dossier | `specimens` (L874) | `currentDossier`, `districtKey` (immutable), `clerkSlug`, `generation` |
| Lore fragments | `loreFragments` (L920) | one per intake/amendment, embedded (`subject_type='lore'`), carries x/y/z from projection |
| District | `districts` (L861) | community over kNN graph, LLM-named character |

### Precomputed (offline / job queue) vs request-time

**Precomputed** (a script and/or a job type; safe to make expensive):
caption embeddings (`backfill-embeddings.ts` / enrich job), kNN graph (`build-knn.ts` / `knn.rebuild`),
2D UMAP (`umap.recompute` -> `umap_projections`), 3D manifold (`manifold.recompute` ->
`manifold_projections`, reproducible seed), surprisal + collection temperature (`compute-entropy.ts` /
`entropy.recompute`), caption grammar (`derive-grammar.ts`), vibe axes (`vibe-axes.ts`), constraint cards,
remix idioms, WebP derivatives, and the entire universe (`universe-bootstrap.ts`, replayable with **zero
API calls** because intake events carry the dossier embedding in their payload).

**Request-time** (cheap, live): gallery centroid (`src/lib/playground/centroid.ts`, lazily cached),
breed/depart/antibreed/subtract (`src/lib/ai/breed.ts`), attention decay (pure read-time math), taste
leaderboard aggregation, `/api/path` Dijkstra, `/api/drift/next` one step (stateless), `/api/search`
query embed + cosine rank.

**Geometry ops that already exist** (`src/lib/ai/vector.ts`, `alive.ts`, `breed.ts`):
`meanVector` (centroid), `subtractVector`, `cosineSim`, `lerpVector(a,b,t)` (unclamped -- can
*extrapolate* past an endpoint), `interpolateEmbeddings` (clamped), `searchByVector(vec, {order:
'nearest'|'farthest'})` (farthest is real, used by antibreed). No slerp. No persisted per-image
centroid-distance column (folded into surprisal at compute time).

### What the data knows that the UI does not yet show

This is the money question. The corpus already holds, but does not surface:

1. **Per-image geometric position** -- every image knows its exact kNN neighbors, their cosine ranks,
   its district, its distance from the gallery centroid, its surprisal. The detail page shows a dossier
   that *may* mention neighbors in prose; it never shows "you are the 3rd-most-isolated record in the
   archive" or renders neighbor references as navigable links. (Track A #1.)
2. **The holes.** The manifold has low-density regions -- coordinates no image occupies. Nothing looks
   for them. (Track A #2.)
3. **Register divergence.** Each image speaks in several caption registers, but only one (the slug
   source) is embedded. The distance between an image's factual and poetic voice is computable and
   never computed. (Track B: register-drift.)
4. **Its own motion.** The gallery centroid drifts as images arrive; collection temperature (dispersion)
   rises and falls over time (`collection_temperature` is a time series). The archive's shape is
   changing and nobody is told. (Track B: manifold weather, fever chart.)
5. **Traffic.** `/connect`, `/drift`, and `/daily` all compute a walk and then **throw it away**. There
   is no record of which image-to-image edges visitors actually traverse. Dwell-on-image exists
   (`image_attention`); path-traffic does not exist at all. (Track A #3 + #4.)
6. **The visitor.** The institution "is always watching" (per /about) but files nothing on the people who
   browse. Their dwell, their paths, their district preferences are latent-space-shaped and unrecorded.
   (Track B: the archive files on you.)
7. **The opposite of any query.** `searchByVector` can already return the farthest images from a vector.
   Search only ever returns the nearest. (Track B: anti-search.)

---

## Track A -- the four committed features

Planned against the real code. Each is one step short of a build brief. Effort is S/M/L relative to this
codebase's existing seams.

### Shared substrates (design these once, before the four)

The task's coupling hint is correct and the code confirms it. Two substrates are shared and should be
built first so nothing is designed twice.

**Substrate 1 -- the traffic ledger (feeds #3 erosion and #4 desire paths).**
`image_attention` already records decayed dwell per image (PII-free, DNT/opt-out respected,
`/api/attention` ingest, 3-day half-life in `src/lib/attention.ts`). Two things are missing and both
features need them:
- a **monotonic lifetime accumulator** per image (wear does not heal, so decay is wrong for erosion),
  and
- a **per-edge / per-path traffic counter** (nothing writes this; `/connect`, `/drift`, `/daily`
  discard the walk).

Build one ingest that extends the existing telemetry: keep the decaying `image_attention.value`,
add `image_attention.lifetime real` (never decays), and add a new `path_traffic(src_id, dst_id,
value real, lifetime real, last_updated_at)` mirroring the attention decay math exactly. `/connect`,
`/drift`, `/daily`, and self-aware-caption neighbor clicks all POST their traversed edges to one new
`POST /api/traffic` (sibling of `/api/attention`, same consent gate). Erosion reads the node
accumulators; desire paths read the edge accumulator. One decay function, one consent posture, two
readers.

**Substrate 2 -- the geometry digest (feeds #1 self-aware captions and #2 negative-space).**
Both features turn kNN/manifold geometry into institutional prose. Precompute nightly, per image, a
`geometry_digest`: its ranked neighbors (with cosine distance and district-relative direction), its
district, its centroid distance/surprisal percentile, and the nearest **hole** (from #2's void survey).
The self-aware caption pass (#1) and the requisition-notice pass (#2) both consume this digest instead
of re-deriving geometry. Store it as a projection table or as fields on `specimens`; it is cheap and
rebuildable.

### A1. Self-aware captions

**What the visitor sees.** On a detail page, beneath the specimen's captions, a short cross-reference
note written in the archive's voice, grounded in the image's *actual* geometry and rendered with the
neighbor slugs as links:

> Cross-references. One door down, another submerged interior keeps the same silence
> (*the-kelp-auditors-desk*). Three doors down the motif recurs, drier, under different management
> (*a-clerk-declines-to-comment*). The nearest record in an adjacent district lies some distance off and
> disagrees about the light.

Ordinal spatial language ("one door down", "three doors down", "across the ward") is derived
deterministically from kNN rank and cross-district distance, so the prose is *true to the manifold*, not
decorative. Clicking a reference walks you there.

**Why it is only partly done.** Clerk dossiers already receive neighbor RAG (`buildDossierPrompt` in
`src/lib/universe/dossier.ts` injects neighbor slug + caption + prior filing and says "cite them if
relevant"). But (a) whether a given dossier actually names a neighbor is left to the model, (b) the
mentions are unstructured prose, never hyperlinked, and (c) they carry no geometric grounding -- no rank,
no direction, no "how far." A1 makes the reference structured, deterministic, and navigable, and extends
it below the dossier onto the public captions.

**Data model.** No new tables required if built as canon. Add a lore fragment `kind='cross_reference'`
per image (already embeddable, already rendered by `dossier-panel.tsx`), or a new caption `variant`
(e.g. 5) tagged as the cross-reference register. Reuse `knn_edges`, `cross_references`, `districts`,
and Substrate 2's geometry digest.

**Precompute vs request-time.** Nightly: for each image, resolve neighbors + ranks + district-relative
direction (Substrate 2), then one LLM call to write 1-2 grounded sentences with slug placeholders.
Persist. Request-time: render placeholders as links (cheap). Regenerate when the kNN graph rebuilds.

**Touchpoints.** New: a `cross-reference` generation pass in `src/lib/universe/` or a new prompt key
(`cross_reference`) resolved through `src/lib/prompts/resolve.ts`; the geometry digest. Modified:
`src/components/dossier-panel.tsx` (or the caption block on `src/app/u/[handle]/[slug]/page.tsx`) to
render linked references; the enrich/reprocess path to trigger regeneration.

**Coupling.** Consumes Substrate 2 with #2 (a reference can point at a *hole*: "to your north, a
specimen the archive has requisitioned but not yet received"). Neighbor-click edges feed Substrate 1,
so reading self-aware captions literally wears the desire paths (#4).

**Effort:** M. **Cost note:** one nightly LLM call per image; a few hundred calls, cheap and batched.

**Open questions for the owner.** (1) Public captions, dossiers, or both? (2) Is the cross-reference a
new caption variant or a canon lore fragment (recommend lore fragment -- it inherits the institutional
voice and the embedding path for free)? (3) Fixed ordinal vocabulary ("one door down") or per-clerk
idiolect?

### A2. Negative-space catalog

**What the visitor sees.** A public "requisitions" register (a `/chronicle`-style page) where the
institution posts notices for specimens that do not exist yet:

> REQUISITION 0007. The archive notes a vacancy between the drowned-telephone district and the
> clock-repair district: a record of an interior, partly flooded, containing a timepiece that has
> stopped. No such specimen is on file. Submission is requested. Until received, this coordinate remains
> under provisional description.

When the owner fills the gap (uploads or generates an image landing near that coordinate), the
requisition is stamped fulfilled and the hole closes; the manifold self-completes.

**Data model.** New event type `requisition.filed` (+ `requisition.fulfilled`) in the append-only
`events` log, and a projection `requisitions(id, hole_vec vector(1536), notice text, clerk_slug,
nearest_image_ids jsonb, status 'open'|'fulfilled', fulfilled_by_image_id, created_at)`. Fits the
existing event-sourced pattern exactly (rebuildable, `dedupe_key` idempotent).

**Precompute vs request-time.** Nightly **void survey** script: sample candidate points in embedding
space (convex combinations of existing vectors via `lerpVector`/`interpolateEmbeddings`, or a grid over
the 2D/3D projection back-projected to neighbors) and score each by distance-to-nearest-image; the
local maxima are holes. For each hole above a threshold, one clerk LLM call writes the requisition
notice from the surrounding captions (reuse the district/dossier machinery). Fulfillment is detected at
intake: when a new image embeds near an open requisition's `hole_vec`, mark it fulfilled and enqueue
`manifold.recompute` + `umap.recompute`.

**Touchpoints.** New: `scripts/void-survey.ts` (or a `void.survey` job), `src/lib/db/queries/
requisitions.ts`, a `/requisitions` page + `GET /api/requisitions`, an `/admin/requisitions`
fulfillment queue modeled on `/admin/breed`. Reuses `src/lib/ai/breed.ts` (centroid-of-neighbors is
exactly the hole's descriptive seed), `imagegen.ts` (the stub `ImageGenerator` -- owner wires a real
text-to-image adapter to auto-generate), `imageLineage` (a generated fill records its parent holes).

**Coupling.** Shares Substrate 2 with #1. The "nearest hole" in the geometry digest is what lets a
self-aware caption gesture at an absence.

**Effort:** L. Void detection is the only genuinely new math; everything downstream reuses breed +
canon + admin patterns. **Cost note:** nightly survey is pure vector math (free) plus one LLM call per
newly-found hole (rare after the first pass).

**Open questions.** (1) Hole detection in full 1536d (honest, less legible) or in the 2D/3D projection
(legible, distorted)? Recommend: detect in full space, *place* on the projection for display. (2) Does
the institution generate fills itself (wire imagegen) or only requisition and wait for the owner? (3)
How many open requisitions at once before it reads as spam -- cap and age them out.

### A3. Erosion

**What the visitor sees.** Images carry visible wear from how they have been treated. A record consulted
constantly is handled -- faint thumbprints, softened edges, a smudge where the eye lingers. A record
nobody requests goes the other way -- dust, foxing, a creep of barnacle/verdigris at the margins. The
wear is procedural and deterministic (seeded per image), rendered as an overlay, and narrated in canon:

> Condition note. Handling consistent with frequent consultation; corners soft, surface clouded.
> vs.
> Condition note. Barnacle growth at lower margin. This record has not been requested in 300 days.

**Why the substrate is nearly there.** `image_attention` already measures dwell, but it *decays*
(3-day half-life) -- correct for "what's hot," wrong for "what's worn," because wear is permanent. A3
needs Substrate 1's **lifetime** accumulator (monotonic handling) plus **neglect** (time since last
meaningful attention). Both are cheap additions to the existing ingest.

**Data model.** Add `image_attention.lifetime real` (Substrate 1). Nightly, compute a wear state per
image and persist `image_wear(image_id, handledness real, neglect real, seed int, kind text,
updated_at)` (or a jsonb `wear` column on `images`). `seed` makes the procedural overlay stable
run-to-run.

**Precompute vs request-time.** Nightly `wear.recompute` job maps (lifetime attention, days-since-last-
attention, reaction/comment counts) to `handledness`/`neglect` scalars. Request-time: a client overlay
component draws the wear procedurally from the seed (SVG/canvas filters -- thumbprint splats and edge
smudge scaling with handledness; dust/barnacle noise scaling with neglect). No per-request compute.

**Touchpoints.** New: `src/lib/wear.ts` (the mapping), a `wear.recompute` job, `src/components/
wear-overlay.tsx`. Modified: image card + detail render to mount the overlay; a canon "condition note"
lore fragment (reuses A1's generation path). Couples naturally with the existing `tidal` and `lonely`
sorts -- wear is the visual complement to lonely-first (the neglected are visibly barnacled), and tidal
browsing surfaces the two extremes against each other.

**Effort:** M. The attention substrate exists; the work is the wear model plus a convincing procedural
overlay. **Cost note:** procedural wear is client-side and free; the condition-note LLM line is optional
and batched.

**Open questions.** (1) How aggressive should wear be -- subtle patina or unmistakable damage? Risk: too
subtle and nobody notices; too strong and it obscures the image. (2) Does heavily-worn ever become
*unreadable* (a record consulted to death), coupling to basement/archive? (3) Respect the attention
opt-out: a visitor who opted out of telemetry still *sees* wear (aggregate, PII-free) but does not
*contribute* to it -- confirm that is acceptable.

### A4. Desire paths

**What the visitor sees.** The routes visitors actually walk between images become real. A frequently-
walked corridor through the graph earns a name and a page of its own; an unwalked one overgrows and
fades. On `/map` and `/manifold`, worn routes render as brighter/thicker edges. The institution files
the route as a thing it now recognizes:

> DESIGNATED ROUTE. The eel-desk to clocktower corridor. Six recorded traversals. Passes through the
> drowned-telephone district. Right of way established by use; the archive did not plan it and does not
> endorse it.

**Why nothing exists yet.** `/connect` (`src/app/api/path/route.ts`, Dijkstra over `knn_edges`),
`/drift` (`/api/drift/next`, explicitly stateless per route.ts:18), and `/daily` all compute a walk and
discard it. There is no per-edge traffic anywhere. A4 is the reader of Substrate 1's edge accumulator.

**Data model.** `path_traffic(src_id, dst_id, value real, lifetime real, last_updated_at)` from
Substrate 1. When a route's accumulated traffic crosses a threshold, promote it: `desire_paths(id, slug,
node_ids jsonb, caption text, traffic real, last_walked_at, created_at)` -- a first-class object with a
generated name/caption and its own decay (an unwalked designated route fades and can be retired). Both
mirror the attention decay math.

**Precompute vs request-time.** Request-time: ingest a completed walk's edges to `path_traffic`
(fire-and-forget, like attention). Nightly `desire.promote` job: promote/retire routes past thresholds
and generate a clerk caption for newly designated ones. Reading traffic to weight map/manifold edges is
a cheap join at render.

**Touchpoints.** New: `POST /api/traffic` (Substrate 1), `src/lib/db/queries/paths.ts`, a
`desire.promote` job, `/paths` index + `/path/[slug]` page, edge-weight overlay in `umap-canvas.tsx` /
`manifold-scene.tsx` (the `highlightPath` seam at connect/page.tsx:358-374 is already designed for path
overlays). Modified: `/connect`, `/drift`, `/daily` to POST their traversed edges.

**Coupling.** Shares Substrate 1 with #3 (build the ingest and decay once). Shares nothing else, but a
designated route's endpoints are natural cross-reference material for #1.

**Effort:** M-L (the ingest is small; the promotion lifecycle + a route page + map overlay is the bulk).
**Cost note:** ingest is free; one LLM caption per newly designated route, rare.

**Open questions.** (1) Is a "path" a specific node sequence, or just the (a,b) endpoints regardless of
route? (Recommend: accumulate per *edge*; designate routes as hot edge-chains -- robust to Dijkstra
returning slightly different paths.) (2) Do `/drift` (free-wander) and `/daily` (puzzle) traversals
count the same as deliberate `/connect` journeys, or is `/connect` weighted higher? (3) Privacy: same
consent gate as attention.

### Shared-substrate summary and build order

| | Substrate 1 (traffic ledger) | Substrate 2 (geometry digest) |
|---|---|---|
| A1 self-aware captions | neighbor-click edges feed it | **reads it** |
| A2 negative-space | -- | **reads it** (nearest hole) |
| A3 erosion | **reads node accumulators** | -- |
| A4 desire paths | **reads edge accumulator** | -- |

**Recommended build order:**
1. **Substrate 1** (extend `image_attention` with `lifetime`; add `path_traffic` + `/api/traffic`).
   Small, unblocks two features.
2. **A4 desire paths** -- smallest new surface on top of existing `/connect`/`/api/path`; proves
   Substrate 1's edge side.
3. **A3 erosion** -- proves Substrate 1's node side; ships the most viscerally novel visual.
4. **Substrate 2** (geometry digest) -- small nightly precompute.
5. **A1 self-aware captions** -- additive canon content on top of the existing dossier machinery.
6. **A2 negative-space** -- largest; needs Substrate 2 + void math + a fulfillment loop. Last.

---

## Track B -- the idea graveyard (all raw ideas + kill reasons)

Fifty-two raw ideas generated across four mechanics before any evaluation. Kept survivors are marked
**-> SURVIVES**; everything else records why it died. This is the useful part: the kills show the
boundary.

### Distant-domain transplants

1. **Tide tables (viewing almanac).** The institution publishes a daily almanac predicting when each
   district will be "in view" under the rotating/tidal sorts: "high water for the octopus district at
   14:20." -> **SURVIVES** (folded into *manifold weather* as its almanac voice).
2. **Cemetery / perpetual care.** Images as graves; neglected plots decay. -> **KILL: duplicates A3
   erosion** (neglect->decay) with a costume.
3. **Epidemiology (motif contagion + contact tracing).** Simulate a motif spreading across the kNN graph
   (SIR); the institution issues contact-tracing notices: "specimen X was exposed to the octopus motif
   via three intermediary records." -> **SURVIVES-as-runner-up** (strong, but overlaps weather's "front"
   metaphor and risks abstraction; see runner-ups).
4. **Mycorrhizal nutrient economy.** Popular images feed attention to lonely neighbors through the
   graph. -> **KILL: this is stigmergy** (attention already flows via drift bias); no new legible object.
5. **Actuarial science (mortality tables).** The institution issues a life-expectancy / risk notice per
   specimen from its isolation, surprisal, and attention: premiums, uninsurability, projected date of
   deaccession. -> **SURVIVES** (the actuarial & deaccession office).
6. **Library deaccessioning with public appeal window.** Flag least-circulated specimens, open a comment
   window, let visitors "rescue." -> **KILL: rescue = like button**; the appeal window is a social
   feature in costume. (The *non-social* deaccession notice survives inside #5.)
7. **Ham radio QSL cards.** Every completed `/connect` journey earns a stamped confirmation-of-contact
   card: call sign, distance, districts crossed, date; collectible. -> **SURVIVES**.
8. **Geology (core samples / stratigraphy).** Drill a vertical core at a manifold coordinate to see the
   time-strata of images that occupied that region. -> **KILL: legibility risk** with 204 images the
   strata are too thin to read; revisit at larger corpus.
9. **Ant pheromone trails.** -> **KILL: this is exactly A4 desire paths.**
10. **Dream interpretation manual.** The institution publishes an oneiromantic dictionary mined from
    tag co-occurrence + captions: "to see an octopus at a counter signifies delegated authority." ->
    **SURVIVES-as-runner-up** (novel and on-register, but browse-once; lower repeat engagement than the
    final seven).
11. **Customs & border inspection.** Entering some districts requires a declaration and a stamp;
    occasionally you are "detained" (an image withholds itself). -> **KILL: merges into** the
    refuse-to-load inversion (#25) and adds friction without a payoff object.
12. **Seed bank / doomsday vault.** One "type specimen" per district sealed as a permanent seed
    collection; a grave-quiet vault view. -> **KILL: duplicates basement** (already a hidden gated
    surface) plus districts; no new mechanic.
13. **Radio dead air / quiet hours.** The archive schedules "closed for inventory" windows showing a
    test card. -> **KILL: probably boring** and user-hostile; a scheduled empty state rarely rewards.
14. **Liturgical calendar / feast days.** Intake anniversaries as feast days; a "specimen of the day"
    elevated with special annotation; fasting periods. -> **SURVIVES-as-runner-up** (charming, but
    overlaps the annual-report/anniversary surface; time-driven novelty is thin).
15. **Competitive breath-holding (hold-to-view).** An image shows only while you hold the mouse/press;
    release and it is gone; the archive records your "dive time." (Referenced in /about.) ->
    **SURVIVES-as-runner-up** (genuinely novel interaction; risk it reads as a gimmick).
16. **Insurance claims adjuster.** File a claim that an image "damaged" you; adjuster replies. ->
    **KILL: UGC-shaped**, invites the moderation problem the site deliberately avoids.
17. **Postal sorting / dead letter office.** Mis-routed specimens accumulate in a dead-letter office.
    -> **SURVIVES-as-fold-in** (becomes the mechanism behind *corrections & clarifications*, #45).
18. **Weather station instruments (barometer/thermometer).** -> **KILL: subsumed by** manifold weather +
    the collection-temperature fever chart.
19. **Numismatics / grading.** Assign each image a coin-grade (MS-65). -> **KILL: this is just a score**;
    a rating with no world around it.
20. **Ornithology field guide / migration.** Track motifs "migrating" across districts seasonally. ->
    **KILL: overlaps** weather (fronts) and centroid migration; no distinct object.

### Inversion sweep

21. **The archive files on you.** The institution catalogues the *visitor* -- a bureaucratic dossier
    written from your dwell, your paths, the districts you favor and avoid: "Visitor exhibits a
    pronounced attraction to submerged interiors and will not look at anything with a face." ->
    **SURVIVES**.
22. **Anti-search (the archive declines).** Type a query; the archive returns the *farthest* images and
    declines your request in favor of its opposite. (`searchByVector` farthest already exists.) ->
    **SURVIVES**.
23. **Assigned sort you cannot choose.** The institution picks your sort order and tells you why, based
    on the time and your prior path. -> **KILL: too thin alone**; folded as a behavior into #21 (the
    archive that reads you can also seat you).
24. **Latency as content (records that develop).** A specimen marked "under review" only resolves after
    you have viewed N others, or returned on a later day. -> **SURVIVES-as-fold-in** (a strong beat
    inside #21's surveillance frame; risky as a standalone because it withholds the product).
25. **Images that refuse to load until conditions met.** -> **KILL as standalone**: user-hostile without
    a frame; survives only as #24's mechanism inside a narrative.
26. **The gallery browsing you (it looks back).** Occasionally an image is "consulting" the visitor. ->
    **KILL: merges into #21.**
27. **Un-shelf / shelf of forgetting.** Add an image to a shelf to *hide* it from your future browsing.
    -> **KILL: niche**, and inverts a feature few will have used enough to want inverted.
28. **Anti-recommendation rail ("unlike anything you've viewed").** -> **KILL: this is #22** pointed at a
    behavior vector instead of a query.

### Geometry-native

29. **Manifold weather.** Nightly, compute a weather system over the projection: density gradients as
    pressure, recent uploads as fronts, centroid drift as prevailing wind; the institution issues a
    forecast bulletin and the map renders isobars. -> **SURVIVES**.
30. **Centroid migration (the wandering heart).** Track and visualize the gallery centroid's path over
    time; note when the archive's center of gravity crosses into a district. -> **KILL as standalone:
    folded into #29** as the "prevailing wind."
31. **Curvature / fault lines.** Mark high-local-curvature regions of the manifold as faults. ->
    **KILL: not legible** to a visitor; a metric with no felt meaning.
32. **Narrated interpolation corridors.** On a `/connect` journey, generate ghost captions for the
    imaginary specimens at each interpolation step between the real stops. -> **KILL: overlaps A2 and
    A4**; the ghost specimens are negative-space content and belong there.
33. **Antipode (your opposite number).** For any image, compute and present its true farthest point. ->
    **KILL as standalone: it is #22** at single-image granularity; keep it as a one-line feature inside
    anti-search.
34. **Fever chart (collection temperature bulletins).** Surface `collection_temperature` as the
    archive's own temperature; issue health bulletins when dispersion spikes. -> **SURVIVES-as-fold-in**
    (becomes a panel of *manifold weather* -- the data already exists).
35. **Named constellations that rotate by time of day.** -> **KILL: overlaps** districts + chronograph;
    decorative.
36. **Void cartography.** -> **KILL: this is A2 negative-space.**
37. **Register-drift (official record vs confession).** Embed each caption register separately; surface
    the cosine distance between an image's factual and poetic voice as a measured tension. Uniquely
    exploits the multi-register asset (currently only one register is embedded). -> **SURVIVES**.
38. **Local intrinsic dimensionality per image.** -> **KILL: unintelligible** to anyone but a geometer.

### Canon-native

39. **Inter-clerk dispute docket.** Where two clerks' filings on one specimen contradict, the institution
    opens a "case" and either a third clerk adjudicates or it is "referred to committee, unresolved." ->
    **SURVIVES-as-runner-up** (excellent use of the conflict asset, but the amendment loop already
    surfaces disagreement; incremental).
40. **Progressive redaction.** Later events "classify" passages of existing dossiers; visitors see
    growing bars of blacked-out text with no explanation. -> **SURVIVES-as-runner-up** (visually
    striking, deadpan-perfect; overlaps the unreliable-archive theme with #45).
41. **Requisition notices.** -> This is A2. Skip.
42. **Visitor commissioned as junior clerk.** After enough activity the institution "commissions" you and
    files on your behalf. -> **KILL: merges into #21** (the archive that files on you is the same asset,
    cleaner).
43. **Audit notices.** The reserved `audit.flagged` event: the institution randomly flags specimens for
    "irregularities," banners them "under audit," clears them a later tick. -> **SURVIVES-as-fold-in**
    (a good recurring beat inside the actuarial/deaccession office, #5).
44. **Chain-of-custody forms.** A stamped form tracing every clerk who handled a specimen. -> **KILL:
    overlaps** QSL cards (#7) and the existing provenance panel; a form with no new information.
45. **Corrections & clarifications.** The unreliable archive publicly corrects itself: it announces that
    a specimen was misfiled into the wrong district and issues a correction -- a standing "corrections"
    column, like a newspaper's. -> **SURVIVES**.
46. **Bureaucratic forms to unlock actions.** Fill a form to view high-res or to connect two images. ->
    **KILL: friction without payoff**; the customs idea (#11) already died for this.
47. **Annual report / census.** Auto-generate a yearly report: population, births (uploads), deaths
    (archivals), busiest district, temperature trend, specimen of note. -> **SURVIVES-as-fold-in**
    (becomes the actuarial office's annual publication, #5).
48. **Overdue notices.** "This record is overdue for consultation." -> **KILL: duplicates A3 erosion**
    (neglect) and #5 (deaccession); the notice is the same signal three times.
49. **District naming ceremony / proclamation.** When community detection births a district, issue a
    proclamation. -> **KILL: too small** and infrequent to be a feature; make it a chronicle line.
50. **The confession booth (register as testimony).** Present the poetic caption as the specimen's
    "statement" against the factual "official record," two-column deposition. -> **KILL as standalone:
    it is #37** (register-drift) rendered dramatically; keep as #37's presentation.
51. **Marginalia the clerks leave for each other.** -> **KILL: this is the amendment loop**, already
    shipped.
52. **The archive's suggestion box that never responds.** Submit a suggestion; it is filed and ignored,
    visibly, forever. -> **KILL: a joke, not a feature**; one gag with no depth.

**Survival rate: 7 of 52 promoted to full mini-specs, ~6 held as runner-ups.** Consistent with the
brief's "expect to kill 80%."

---

## Track B -- the survivors (ranked mini-specs)

Ranked by engagement-per-effort. Constraints satisfied: geometry-native survivors present (anti-search,
register-drift, manifold weather); canon-native survivors present (corrections, the archive files on
you, actuarial office); exactly **one** survivor (QSL cards) is primarily an extension of a Track A
feature (A4), within the limit of two.

### 1. Anti-search -- "the archive declines your request"

**Concept.** You type what you are looking for; the archive embeds it, and returns the records farthest
from it, on the principle that you already know what you came for and the institution's duty lies
elsewhere. A search that answers a question you did not ask.

**Why impossible elsewhere.** Ledger assets 1 (embedding space) + 3 (canon frame) + 4 (total control).
Every search product optimizes toward the query; only an archive with no obligation to be useful, over a
coherent latent space, can meaningfully return the *opposite* and mean it. `searchByVector(vec,
{order:'farthest'})` already exists (antibreed uses it); the mechanism is a toggle, the novelty is the
framing.

**Architecture.** A `mode=decline` (or a `/decline` route) on the existing `/api/search`: embed the
query, call `searchByVector` with `order:'farthest'`, wrap results in a short institutional refusal
generated once and cached per query-cluster (or fully canned). Add a single-image "opposite number"
(antipode) link on detail pages reusing the same call.

**Effort:** S. **Risk (honest):** it might be a one-joke feature -- funny once, then ignored. Mitigation:
make the *refusals* varied and clerk-voiced so the return, not the gag, is the draw; and wire the
single-image antipode so it lives inside normal browsing, not only on a novelty page.

### 2. Corrections & clarifications -- the archive that admits it misfiles

**Concept.** The institution maintains a standing corrections column. Periodically it announces that a
specimen was filed into the wrong district, or that an earlier annotation was in error, and issues a
formal correction -- without ever quite explaining how the mistake occurred.

**Why impossible elsewhere.** Ledger assets 3 (canon) + 1 (geometry gives *real* misfilings to
"correct": a specimen whose district-at-intake no longer matches its nearest cluster after the graph
rebuilds is a genuine, detectable discrepancy) + 4 (only an owner with no accuracy obligation would ship
an archive that publicly declares itself unreliable). The /about voice already promises this ("Location
data is stripped on upload. A different location is then assigned").

**Architecture.** Nightly, diff each specimen's immutable `districtKey` against its *current* nearest
district (recompute community membership). Real drift -> a `correction.filed` event + a chronicle entry,
clerk-voiced. Occasionally seed a purely fictional correction for texture. New event type + a
`/chronicle` filter; reuses districts, community detection, the event log. No new heavy machinery.

**Effort:** S. **Risk:** if corrections are too frequent they read as noise; too rare and nobody notices
the column exists. Mitigation: cap to a small cadence and let a real geometric drift trigger most of
them so they land as uncanny rather than random.

### 3. QSL cards -- confirmations of contact

**Concept.** Every completed journey through the similarity graph (a `/connect` walk) is confirmed by
the archive with a stamped card in the manner of a ham-radio QSL: the two endpoints, the districts
crossed, the total cosine distance "logged," a date, and a call sign. Collectible, shareable, filed.

**Why impossible elsewhere.** Ledger assets 1 (the graph traversal being confirmed is a real geodesic
over the embedding space) + 3 (the confirming authority is the fiction). Strava issues route cards for
runs; the transplant here is a bureaucratic radio-operator confirming a *semantic* traversal between two
images -- not a fitness stat. The card is a document about a walk through meaning, which requires the
corpus and the graph to exist.

**Architecture.** On a completed `/connect` render, mint a card from the already-computed `PathNode[]` +
`totalDist` + district lookups; render server-side to an image/OG card (reuse the existing SEO card
machinery) at a stable `/qsl/[hash]` URL. Persisting the walk also feeds Track A #4's `path_traffic`
(Substrate 1) -- so QSL and desire paths share the same ingest.

**Effort:** S-M. **Risk:** collectibility only matters if journeys are worth taking; QSL rides on
`/connect` being fun. Mitigation: it costs little and directly reinforces A4, so even modest uptake pays
for itself.

### 4. The archive files on you -- a dossier on the visitor

**Concept.** The institution, which is always watching, keeps a file on the reader. From your dwell,
your paths, and the districts you linger in or avoid, a clerk writes a short dossier about *you* -- in
the same conflicted, agenda-driven voice it uses on the images. It is not flattering and it does not ask
permission.

**Why impossible elsewhere.** Ledger assets 3 (canon voice) + 1 (your behavior is projected into the
same latent space as the images -- "you dwell in the submerged-interior district and flee faces" is a
computable centroid of what you looked at) + 4 (an owner free of the reassurance a real product owes its
users). The nearest prior art is a year-in-review dashboard; this is its total inversion -- surveillant,
latent-space-grounded, and deadpan rather than celebratory.

**Architecture.** Reuse the attention telemetry and (if built) Substrate 1's path traffic, all PII-free
and consent-gated. Aggregate the visitor's session into a behavior centroid + district histogram
client-side or by fingerprint; one clerk LLM call (cached per session) renders the dossier. No new
tables strictly required if session-scoped; a `visitor_files` projection is optional for persistence.
Respects the existing DNT/opt-out posture -- opted-out visitors get no file (and the institution notes
their absence, in character).

**Effort:** M. **Risk:** surveillance framing can tip from uncanny to creepy or preachy. Mitigation:
keep it strictly diegetic (a clerk's filing, never a real analytics readout), aggregate-only, and honor
opt-out visibly.

### 5. Manifold weather -- forecasts over the latent landscape

**Concept.** The archive treats its own embedding space as terrain with weather. Density is pressure,
recent uploads are fronts moving through, the drifting centroid is the prevailing wind, and dispersion
(collection temperature) is the day's heat. The institution issues a forecast, and the map shows
isobars.

**Why impossible elsewhere.** Ledger assets 1 (all the weather variables are real manifold measurements:
local density, centroid velocity, `collection_temperature` history) + 3 (the forecaster is the fiction)
+ 5 (nightly offline compute makes the daily model free). No image platform narrates its own latent
space as a weather system, because no image platform has a single coherent latent space to have weather
in.

**Architecture.** Nightly `weather.recompute` job: density field over the UMAP projection, centroid
delta vs prior runs, temperature trend from `collection_temperature`; store a small `weather` snapshot.
A forecast bulletin (one LLM call) plus an isobar/wind overlay on `umap-canvas.tsx`. Folds in the
fever-chart (#34), centroid-migration (#30), and viewing-almanac (#1) ideas as panels.

**Effort:** M-L. **Risk:** the metaphor can outrun legibility -- "pressure over the clock district"
means nothing if the map is not already familiar to the visitor. Mitigation: ship it as an overlay on
the *existing* `/map` people already read, with a plain-language bulletin doing the interpreting, and
keep the physics honest (only show weather the geometry actually supports).

### 6. Register-drift -- the official record vs the confession

**Concept.** Each specimen speaks in several registers, from the flat factual caption to the poetic one.
The archive measures how far apart a record's official description and its confession actually are, in
the same space it measures everything else, and files the ones whose two voices most disagree as
specimens "of divided testimony."

**Why impossible elsewhere.** Ledger asset 2 (multiple caption registers per image) is the whole
feature, and it is the least-exploited asset on the ledger -- today only the slug-source caption is
embedded. Measuring the cosine distance between an image's factual and poetic self is a thing only this
corpus can do, because only this corpus writes the same image in multiple deliberate voices.

**Architecture.** New nightly pass embedding *all* caption/description registers (not just the slug
source) into `embeddings` (the table already supports multiple rows per subject via `kind`). Per image,
compute inter-register distance; surface the spread on the detail page (a two-column "record vs
statement" and a single divergence number) and add a "divided testimony" chronicle filter and possibly a
sort. Reuses the embedder and the existing embeddings table.

**Effort:** M. **Cost note:** embedding a few extra registers per image is a one-time backfill plus
per-upload increment -- cheap, `text-embedding-3-small`. **Risk:** it might be boring -- a distance
number is abstract, and "these two sentences are 0.4 apart" may not move anyone. Mitigation: lead with
the *juxtaposition* (the two voices side by side, the drama visible in the text) and treat the number as
supporting evidence, not the headline.

### 7. The actuarial & deaccession office

**Concept.** A department that treats specimens as liabilities. From a record's isolation, its
surprisal, and how often it is consulted, the office issues an actuarial notice: a projected life
expectancy on file, a "premium" of attention it must pay to stay, an occasional audit flag, and -- for
the truly unvisited -- a notice of proposed deaccession. It also publishes an annual census.

**Why impossible elsewhere.** Ledger assets 3 (canon) + 1 (the risk model is real: surprisal and kNN
isolation are computed; an outlier specimen genuinely is "actuarially" unusual) + 5 (nightly scoring is
free) + 4 (only an owner who will never actually delete can afford to have a department that threatens
to). Deadpan-perfect against the /about promise that images are "transferred, not deleted." Folds in
audit notices (#43), the census/annual report (#47), and the non-social deaccession notice (#6).

**Architecture.** Nightly `actuarial.recompute`: score each specimen from surprisal + kNN degree +
lifetime/decayed attention (Substrate 1 if present, else `image_attention` + reactions/comments);
generate notices for threshold-crossers as canon events; a `/chronicle` filter or a dedicated register
page; an annual census as a generated document. Reuses surprisal, kNN, attention, the event log.

**Effort:** M. **Risk:** threatening to remove content the archive will never remove could read as empty
theater once visitors learn nothing is ever deleted. Mitigation: lean into that -- the joke *is* the
institution's impotence; the deaccession notice that is filed and never acted on is the point, and the
annual census gives the office real, non-threatening substance.

### Ranking rationale

| # | Feature | Ledger assets | Native | Track-A ext. | Effort | Engagement/effort |
|---|---|---|---|---|---|---|
| 1 | Anti-search | 1,3,4 | geometry | no | S | very high |
| 2 | Corrections & clarifications | 1,3,4 | canon | no | S | high |
| 3 | QSL cards | 1,3 | canon+geom | **A4** | S-M | high |
| 4 | The archive files on you | 1,3,4 | canon | no | M | high (highest novelty) |
| 5 | Manifold weather | 1,3,5 | geometry | no | M-L | high (highest ceiling, some risk) |
| 6 | Register-drift | 2 | geometry | no | M | medium (uniquely impossible) |
| 7 | Actuarial & deaccession office | 1,3,4,5 | canon | no | M | medium-high |

**Runner-ups worth keeping on the bench** (survived Phase 3 but did not make the seven): motif
contagion + contact tracing (#3 -- strong, overlaps weather), the dream dictionary (#10 -- lovely,
browse-once), inter-clerk dispute docket (#39 -- incremental over the amendment loop), progressive
redaction (#40 -- striking, overlaps corrections), the liturgical calendar (#14), and breath-holding
hold-to-view (#15 -- most novel interaction, highest gimmick risk).

---

## Recommendation and hand-off

**Track A:** build the two shared substrates first, then A4 -> A3 -> A1 -> A2. The substrates are the
whole reason the four cohere; building them once is the difference between an attention-ecology and four
features that each reinvent telemetry.

**Track B:** if picking a small starter set, **anti-search + corrections** are both S-effort, both
land immediately, and together establish the "the institution has opinions and is not on your side"
posture that makes the heavier ideas (the visitor dossier, the actuarial office) legible when they
arrive. **The archive files on you** is the highest-novelty single feature and the one most worth doing
carefully. **Register-drift** is the only survivor that exploits the multi-register asset and is worth
building for that reason alone even though its engagement ceiling is lower.

Nothing here has been built. This document is the input to the owner's selection: pick the winners and
the sequence, and each chosen item converts to a preclaud-style implementation brief with minimal extra
thinking.
