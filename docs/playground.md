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

## Surprises / known landmines

- **The corpus is small and uneven.** With ~107 images and ~650 caption/description rows, most extracted templates appear once. The default `MIN_TEMPLATE_FREQ = 1` keeps everything; tighten to 2 if the skeleton output feels noisy.
- **compromise tags some words ambiguously.** Words like "fish" get a `Noun|Verb` `switch` tag; the extractor lands them as Noun, which is right for most pix.fish captions but occasionally wrong. Look for `[noun] [noun]` chains where one really should have been a verb.
- **The "first sentence of description" heuristic** drops a lot of voice that lives in the second sentence. For a richer artifact, expand `loadCorpus` to take the full description; expect more noise.
- **Cards are global.** A future per-user remix idiom list (Phase 3) will need an `owner_id` column on `constraint_cards`. The current schema is the minimal shippable shape.

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
- LLM positional disambiguation (template `[noun_1]` vs `[noun_2]` named per template).
