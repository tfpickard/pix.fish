import type { AiConfigMap } from './types';
import { ANTHROPIC_DEFAULT_MODEL } from './anthropic';
import { OPENAI_DEFAULT_EMBED_MODEL } from './openai';

// Defaults used when the ai_config DB table has no row for a field.
// scripts/seed.ts upserts these into the table; loadAiConfig() also falls
// back to them at read time so the app works without an explicit seed run.
// Cheap Haiku default for the classification-y / high-volume / cost-sensitive
// fields (tags, the NSFW rescan, the chat widget). Dated id (not the alias) so a
// reprocess can diff provenance against a specific snapshot, matching the prior
// hardcoded NSFW/Pisci pins.
const HAIKU_DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

export const defaultAiConfig: AiConfigMap = {
  captions: { provider: 'anthropic', model: ANTHROPIC_DEFAULT_MODEL },
  descriptions: { provider: 'anthropic', model: ANTHROPIC_DEFAULT_MODEL },
  // Tags are a structured extraction + NSFW gate -- a lower quality bar than
  // prose, so default to the cheaper Haiku tier.
  tags: { provider: 'anthropic', model: HAIKU_DEFAULT_MODEL },
  // Anthropic has no public embeddings API yet; OpenAI text-embedding-3-small
  // is the Phase 2 default (SPEC.md "Open decisions").
  embeddings: { provider: 'openai', model: OPENAI_DEFAULT_EMBED_MODEL },
  // Character pipeline -- previously all piggybacked on `captions`. detect +
  // verify are vision passes; dossier is the text synthesis for census + amend.
  detect: { provider: 'anthropic', model: ANTHROPIC_DEFAULT_MODEL },
  verify: { provider: 'anthropic', model: ANTHROPIC_DEFAULT_MODEL },
  dossier: { provider: 'anthropic', model: ANTHROPIC_DEFAULT_MODEL },
  // Standalone NSFW rescan + Pisci chat widget -- previously hardcoded Haiku.
  nsfw: { provider: 'anthropic', model: HAIKU_DEFAULT_MODEL },
  chat: { provider: 'anthropic', model: HAIKU_DEFAULT_MODEL },
  // Outbound X dispatch, split into its two calls because they want opposite
  // things from a model.
  //
  // `dispatch` writes the CAPTION -- the whole creative deliverable, judged
  // against a seven-rule tone contract that a cheap model does not reliably
  // hold. A better tier is a legitimate choice here, including a thinking one.
  //
  // `dispatchSafety` is the trend classifier: a mechanical "is this topic
  // grim?" over a batch, emitting fixed-shape JSON. Reasoning buys nothing and
  // costs the one thing this call has least of -- it runs inside a per-call
  // deadline that has to fit alongside everything else in a 50s job, so a slow
  // model here does not produce a worse verdict, it produces no post at all.
  // Haiku, and it should stay Haiku unless there is a reason.
  //
  // Keeping them on one row meant choosing a caption model silently dragged the
  // classifier along with it. Both are Anthropic-only: src/lib/ai/dispatch-text.ts
  // speaks no other provider, so repointing either disables that call rather
  // than switching it.
  dispatch: { provider: 'anthropic', model: ANTHROPIC_DEFAULT_MODEL },
  dispatchSafety: { provider: 'anthropic', model: HAIKU_DEFAULT_MODEL }
};
