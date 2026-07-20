import { listAiConfig } from '@/lib/db/queries/ai-config';
import { defaultAiConfig } from './config';
import type { AiConfigMap, ProviderField, ProviderName } from './types';

const FIELDS: ProviderField[] = [
  'captions',
  'descriptions',
  'tags',
  'embeddings',
  'detect',
  'verify',
  'dossier',
  'nsfw',
  'chat'
];
const KNOWN_PROVIDERS: ProviderName[] = ['anthropic', 'openai'];

// The character-pipeline fields inherit the resolved `captions` routing until an
// owner sets them explicitly. Before they were split out, detect/verify/dossier
// all called getProvider('captions'), so defaulting them to a hardcoded Anthropic
// model would silently switch an OpenAI-only or custom-captioned install onto
// Sonnet 5 (and break detection outright when there's no Anthropic key). They are
// intentionally NOT seeded (see scripts/seed.ts) so "no row" means "inherit".
const INHERIT_CAPTIONS: ProviderField[] = ['detect', 'verify', 'dossier'];

// Read-only. If a row is missing or contains an unknown provider we fall back
// to the default so the app keeps working even when seed has not run. Writes
// happen via scripts/seed.ts (upsert) or /api/admin/ai-config (owner UI).
export async function loadAiConfig(): Promise<AiConfigMap> {
  const rows = await listAiConfig();
  const byField = new Map(rows.map((r) => [r.field, r] as const));
  const out = { ...defaultAiConfig };
  const explicit = new Set<ProviderField>();
  for (const field of FIELDS) {
    const row = byField.get(field);
    if (!row) continue;
    if (!(KNOWN_PROVIDERS as string[]).includes(row.provider)) continue;
    out[field] = { provider: row.provider as ProviderName, model: row.model };
    explicit.add(field);
  }
  for (const field of INHERIT_CAPTIONS) {
    if (!explicit.has(field)) out[field] = out.captions;
  }
  return out;
}

// Reads the imagegen-specific row from ai_config. Lives here rather than in
// loadAiConfig() to avoid widening ProviderName/ProviderField -- imagegen
// uses a different provider set (openrouter, stub) than the enrichment pipeline.
export async function loadImageGenConfig(): Promise<{ provider: string; model: string }> {
  const rows = await listAiConfig();
  const row = rows.find((r) => r.field === 'imagegen');
  if (!row) return { provider: 'stub', model: 'placeholder-1x1' };
  return { provider: row.provider, model: row.model };
}
