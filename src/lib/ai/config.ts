import type { AiConfigMap } from './types';
import { ANTHROPIC_DEFAULT_MODEL } from './anthropic';
import { OPENAI_DEFAULT_EMBED_MODEL } from './openai';

// Defaults used when the ai_config DB table has no row for a field.
// scripts/seed.ts upserts these into the table; loadAiConfig() also falls
// back to them at read time so the app works without an explicit seed run.
export const defaultAiConfig: AiConfigMap = {
  captions: { provider: 'anthropic', model: ANTHROPIC_DEFAULT_MODEL },
  descriptions: { provider: 'anthropic', model: ANTHROPIC_DEFAULT_MODEL },
  tags: { provider: 'anthropic', model: ANTHROPIC_DEFAULT_MODEL },
  // Anthropic has no public embeddings API yet; OpenAI text-embedding-3-small
  // is the Phase 2 default (SPEC.md "Open decisions").
  embeddings: { provider: 'openai', model: OPENAI_DEFAULT_EMBED_MODEL }
};
