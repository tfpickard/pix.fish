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

export type { AIProvider, AITag, ProviderField, ProviderName } from './types';
