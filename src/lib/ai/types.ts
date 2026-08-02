export type AITag = {
  tag: string;
  source: 'taxonomy' | 'freeform';
  confidence?: number;
};

// Result of the tag pass. The same call also classifies NSFW so we don't
// burn an extra round-trip on a separate vision request.
export type TagsAndNsfw = { tags: AITag[]; nsfw: boolean };

// imageUrl is optional; when the caller has a public URL (Vercel Blob),
// passing it lets providers fetch the image remotely instead of base64'ing
// a buffer inline. Anthropic caps inline base64 at 5 MB; URL source has no
// size cap, just an 8000x8000 pixel limit. Providers that receive both
// should prefer the URL.
export interface AIProvider {
  readonly name: string;
  readonly model: string;

  captions(image: Buffer, mime: string, prompt: string, imageUrl?: string): Promise<string[]>;
  descriptions(image: Buffer, mime: string, prompt: string, imageUrl?: string): Promise<string[]>;
  tags(image: Buffer, mime: string, prompt: string, imageUrl?: string): Promise<TagsAndNsfw>;
  // Text-only completion, no image. Used by non-vision generators (about
  // page copy, etc.). Optional because an embeddings-only provider instance
  // doesn't need it.
  text?(prompt: string): Promise<string>;
  // Raw vision call: send an image + prompt, return the model's text verbatim
  // (no shape assumptions). Used by callers that want their own structured
  // output, e.g. character detection asking for bounding-box JSON. Parsing is
  // the caller's job (see parseDetectionsJson).
  vision?(image: Buffer, mime: string, prompt: string, imageUrl?: string): Promise<string>;
  // Optional. Embedding providers expose a distinct model from the vision
  // model, so callers should read `embedModel` when persisting a provenance
  // stamp on an embedding row.
  embed?(input: string): Promise<number[]>;
  readonly embedModel?: string;
}

// Per-field routing keys. The first four are the enrichment pipeline; `detect`,
// `verify`, and `dossier` are the character pipeline (previously hardwired to the
// `captions` field); `nsfw` and `chat` were previously hardcoded to Haiku.
export type ProviderField =
  | 'captions'
  | 'descriptions'
  | 'tags'
  | 'embeddings'
  | 'detect'
  | 'verify'
  | 'dossier'
  | 'nsfw'
  | 'chat'
  | 'dispatch'
  | 'dispatchSafety';
export type ProviderName = 'anthropic' | 'openai';

// Resolved per-field routing. Produced by src/lib/ai/loadConfig.ts from the
// ai_config DB table, falling back to defaults from src/lib/ai/config.ts.
export type AiConfigMap = Record<ProviderField, { provider: ProviderName; model: string }>;

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

// Phase E: the tag-pass response carries a sibling `nsfw: boolean` next
// to `tags: [...]`. Old responses without `nsfw` parse as nsfw=false.
export function parseTagsJson(raw: string): TagsAndNsfw {
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
  return {
    tags: [...byTag.values()],
    nsfw: obj?.nsfw === true
  };
}

// A detected figure in an image: a short label, a rich visual description
// (embedded for clustering), and a NORMALIZED bounding box (each in 0..1, so
// it is resolution-independent and gets converted to pixels at crop time).
export type Detection = {
  label: string;
  description: string;
  box: { left: number; top: number; width: number; height: number };
};

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// Parse the character-detection response: `{ figures: [{label, description,
// box: {left, top, width, height}}] }`, boxes normalized 0..1. Tolerates fenced
// JSON and drops malformed/out-of-range entries rather than throwing.
export function parseDetectionsJson(raw: string): Detection[] {
  const obj = tryParseJson(raw);
  const list = Array.isArray(obj?.figures)
    ? obj.figures
    : Array.isArray(obj?.detections)
      ? obj.detections
      : Array.isArray(obj)
        ? obj
        : [];
  const out: Detection[] = [];
  for (const entry of list) {
    if (!entry || typeof entry.label !== 'string' || typeof entry.description !== 'string') continue;
    const b = entry.box ?? entry.bbox ?? entry.boundingBox;
    if (!b) continue;
    const left = clamp01(Number(b.left ?? b.x));
    const top = clamp01(Number(b.top ?? b.y));
    let width = Number(b.width ?? b.w);
    let height = Number(b.height ?? b.h);
    if (![left, top, width, height].every((n) => Number.isFinite(n))) continue;
    // Keep the box inside the image.
    width = clamp01(width);
    height = clamp01(height);
    if (left + width > 1) width = 1 - left;
    if (top + height > 1) height = 1 - top;
    if (width <= 0 || height <= 0) continue;
    const label = entry.label.trim();
    const description = entry.description.trim();
    if (!label || !description) continue;
    out.push({ label, description, box: { left, top, width, height } });
  }
  return out;
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
