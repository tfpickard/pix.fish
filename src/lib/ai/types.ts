export type AITag = {
  tag: string;
  source: 'taxonomy' | 'freeform';
  confidence?: number;
};

export interface AIProvider {
  readonly name: string;
  readonly model: string;

  captions(image: Buffer, mime: string, prompt: string): Promise<string[]>;
  descriptions(image: Buffer, mime: string, prompt: string): Promise<string[]>;
  tags(image: Buffer, mime: string, prompt: string): Promise<AITag[]>;
}

export type ProviderField = 'captions' | 'descriptions' | 'tags';
export type ProviderName = 'anthropic' | 'openai';

// Helpers shared by provider implementations.

export function parseVariantsJson(raw: string): string[] {
  const obj = tryParseJson(raw);
  const vals = [obj?.variant1, obj?.variant2, obj?.variant3];
  const cleaned = vals
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean);
  while (cleaned.length < 3) cleaned.push('');
  return cleaned.slice(0, 3);
}

export function parseTagsJson(raw: string): AITag[] {
  const obj = tryParseJson(raw);
  const list = Array.isArray(obj?.tags) ? obj.tags : [];
  const out: AITag[] = [];
  for (const entry of list) {
    if (!entry || typeof entry.tag !== 'string') continue;
    const tag = entry.tag.trim().toLowerCase();
    if (!tag) continue;
    const source: 'taxonomy' | 'freeform' =
      entry.source === 'taxonomy' || entry.source === 'freeform' ? entry.source : 'freeform';
    const confidence = typeof entry.confidence === 'number' ? entry.confidence : undefined;
    out.push({ tag, source, confidence });
  }
  // dedupe by tag, prefer taxonomy source on collision
  const byTag = new Map<string, AITag>();
  for (const t of out) {
    const prev = byTag.get(t.tag);
    if (!prev || (prev.source === 'freeform' && t.source === 'taxonomy')) {
      byTag.set(t.tag, t);
    }
  }
  return [...byTag.values()];
}

function tryParseJson(raw: string): any {
  const s = extractJson(raw);
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

// Models sometimes wrap JSON in fenced code blocks. Strip that before parsing.
function extractJson(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) return fence[1]!.trim();
  return trimmed;
}
