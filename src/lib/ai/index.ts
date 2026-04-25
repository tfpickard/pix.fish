import { createAnthropicProvider } from './anthropic';
import { createOpenAIProvider } from './openai';
import type { AIProvider, AiConfigMap, ProviderField, ProviderName } from './types';
import type { UserProviderKeys } from './keys';

// No instance cache. Each call constructs a fresh SDK client because the
// per-user apiKey is part of the construction args, and pooling on
// (provider, model, apiKey) would either grow unbounded or risk leaking
// keys across users when the cache key is misjudged. SDK construction is
// O(microseconds), so it's fine.

function instanceFor(
  name: ProviderName,
  model: string,
  apiKey: string,
  embedModel?: string
): AIProvider {
  if (name === 'anthropic') return createAnthropicProvider(apiKey, model);
  if (name === 'openai') return createOpenAIProvider(apiKey, { visionModel: model, embedModel });
  throw new Error(`unknown provider: ${String(name)}`);
}

// Returns null when the resolved provider for `field` has no usable key
// for the current user. Callers must treat null as "skip this field" --
// enrichment.ts emits empty arrays so the rest of the upload still
// succeeds.
export function getProvider(
  field: ProviderField,
  cfg: AiConfigMap,
  keys: UserProviderKeys
): AIProvider | null {
  const row = cfg[field];
  const apiKey = keys[row.provider];
  if (!apiKey) return null;
  return instanceFor(row.provider, row.model, apiKey);
}

// Narrows the embeddings provider so callers get a non-nullable `embed`
// and an `embedModel` string. Returns null when the user has no key for
// the configured embeddings provider; the caller should skip embedding.
export function getEmbedder(
  cfg: AiConfigMap,
  keys: UserProviderKeys
): { name: string; model: string; embed: (input: string) => Promise<number[]> } | null {
  const row = cfg.embeddings;
  const apiKey = keys[row.provider];
  if (!apiKey) return null;
  // Embeddings-only instance: cfg.embeddings.model is the embed model;
  // pass it as both visionModel and embedModel. Only .embed() will be
  // called.
  const p = instanceFor(row.provider, row.model, apiKey, row.model);
  if (!p.embed || !p.embedModel) {
    throw new Error(
      `provider ${p.name} is configured for embeddings but does not implement embed()`
    );
  }
  return { name: p.name, model: p.embedModel, embed: p.embed.bind(p) };
}

export type { AIProvider, AITag, AiConfigMap, ProviderField, ProviderName } from './types';
export type { UserProviderKeys } from './keys';
export { loadUserProviderKeys, encryptProviderKey, decryptProviderKey } from './keys';
