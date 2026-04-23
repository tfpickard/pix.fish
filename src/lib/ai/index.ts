import { createAnthropicProvider } from './anthropic';
import { createOpenAIProvider } from './openai';
import type { AIProvider, AiConfigMap, ProviderField, ProviderName } from './types';

// Cache provider instances per (provider, model) so we don't rebuild on every
// request. The cache lives for the process lifetime; aiConfig edits take
// effect on next request because getProvider() reads the passed-in cfg and
// the cache key encodes the model.
const cache = new Map<string, AIProvider>();

function instanceFor(name: ProviderName, model: string, embedModel?: string): AIProvider {
  const key = `${name}:${model}:${embedModel ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let inst: AIProvider;
  if (name === 'anthropic') {
    inst = createAnthropicProvider(model);
  } else if (name === 'openai') {
    inst = createOpenAIProvider({ visionModel: model, embedModel });
  } else {
    throw new Error(`unknown provider: ${String(name)}`);
  }
  cache.set(key, inst);
  return inst;
}

export function getProvider(field: ProviderField, cfg: AiConfigMap): AIProvider {
  const row = cfg[field];
  return instanceFor(row.provider, row.model);
}

// Narrows the embeddings provider so callers get a non-nullable `embed` and
// an `embedModel` string. Throws eagerly if the configured provider doesn't
// implement embeddings (e.g. anthropic today).
export function getEmbedder(cfg: AiConfigMap): {
  name: string;
  model: string;
  embed: (input: string) => Promise<number[]>;
} {
  const row = cfg.embeddings;
  // Embeddings-only instance: cfg.embeddings.model is the embed model; pass
  // it as both visionModel and embedModel. Only .embed() will be called.
  const p = instanceFor(row.provider, row.model, row.model);
  if (!p.embed || !p.embedModel) {
    throw new Error(`provider ${p.name} is configured for embeddings but does not implement embed()`);
  }
  return { name: p.name, model: p.embedModel, embed: p.embed.bind(p) };
}

export type { AIProvider, AITag, AiConfigMap, ProviderField, ProviderName } from './types';
