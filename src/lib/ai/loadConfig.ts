import { listAiConfig } from '@/lib/db/queries/ai-config';
import { defaultAiConfig } from './config';
import type { AiConfigMap, ProviderField, ProviderName } from './types';

const FIELDS: ProviderField[] = ['captions', 'descriptions', 'tags', 'embeddings'];
const KNOWN_PROVIDERS: ProviderName[] = ['anthropic', 'openai'];

// Read-only. If a row is missing or contains an unknown provider we fall back
// to the default so the app keeps working even when seed has not run. Writes
// happen via scripts/seed.ts (upsert) or /api/admin/ai-config (owner UI).
export async function loadAiConfig(): Promise<AiConfigMap> {
  const rows = await listAiConfig();
  const byField = new Map(rows.map((r) => [r.field, r] as const));
  const out = { ...defaultAiConfig };
  for (const field of FIELDS) {
    const row = byField.get(field);
    if (!row) continue;
    if (!(KNOWN_PROVIDERS as string[]).includes(row.provider)) continue;
    out[field] = { provider: row.provider as ProviderName, model: row.model };
  }
  return out;
}
