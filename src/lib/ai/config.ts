import type { ProviderField, ProviderName } from './types';

// Phase 1: static per-field provider routing.
// Phase 3 will move this to the ai_config DB table and expose an admin UI.
export const providerConfig: Record<ProviderField, ProviderName> = {
  captions: 'anthropic',
  descriptions: 'anthropic',
  tags: 'anthropic'
};
