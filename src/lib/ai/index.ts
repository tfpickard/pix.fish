import { AnthropicProvider } from './anthropic';
import { OpenAIProvider } from './openai';
import { providerConfig } from './config';
import type { AIProvider, ProviderField, ProviderName } from './types';

const providers: Record<ProviderName, AIProvider> = {
  anthropic: AnthropicProvider,
  openai: OpenAIProvider
};

export function getProvider(field: ProviderField): AIProvider {
  const name = providerConfig[field];
  return providers[name];
}

// Narrows the embeddings provider so callers get a non-nullable `embed` and an
// `embedModel` string. Throws eagerly if the router is pointed at a provider
// that doesn't implement embeddings (e.g. anthropic today).
export function getEmbedder(): {
  name: string;
  model: string;
  embed: (input: string) => Promise<number[]>;
} {
  const p = getProvider('embeddings');
  if (!p.embed || !p.embedModel) {
    throw new Error(`provider ${p.name} is configured for embeddings but does not implement embed()`);
  }
  return { name: p.name, model: p.embedModel, embed: p.embed.bind(p) };
}

export type { AIProvider, AITag, ProviderField, ProviderName } from './types';
