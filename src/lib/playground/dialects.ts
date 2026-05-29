// Pure transforms from a canonical prompt to model-specific dialects. Each
// dialect is one function. No model calls; the playground UI runs these in
// the browser via the same module imported on the server.

export type CanonicalPrompt = {
  subject: string;
  modifiers: string[];
};

export const DIALECTS = ['midjourney', 'flux', 'sdxl', 'dalle3', 'sora'] as const;
export type Dialect = (typeof DIALECTS)[number];

export function isDialect(value: string): value is Dialect {
  return (DIALECTS as readonly string[]).includes(value);
}

export const DIALECT_LABELS: Record<Dialect, string> = {
  midjourney: 'Midjourney v7',
  flux: 'Flux',
  sdxl: 'SDXL',
  dalle3: 'DALL-E 3',
  sora: 'Sora'
};

const DEFAULT_MJ_FLAGS = '--ar 16:9 --s 250';

function cleanSubject(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function cleanModifier(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function kebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Midjourney: subject first, comma-separated modifiers, trailing CLI flags.
export function toMidjourney(p: CanonicalPrompt): string {
  const parts = [cleanSubject(p.subject), ...p.modifiers.map(cleanModifier).filter(Boolean)];
  const body = parts.filter(Boolean).join(', ');
  return body ? `${body} ${DEFAULT_MJ_FLAGS}` : DEFAULT_MJ_FLAGS;
}

// Flux: long-form natural-language sentence. Modifiers folded in with "with"
// connectors so the result reads like prose, not a tag list.
export function toFlux(p: CanonicalPrompt): string {
  const subject = cleanSubject(p.subject);
  const mods = p.modifiers.map(cleanModifier).filter(Boolean);
  if (mods.length === 0) {
    return subject ? `A photograph of ${subject.toLowerCase()}.` : '';
  }
  const lead = subject
    ? `A photograph of ${subject.toLowerCase()}`
    : 'An image';
  return `${lead}, ${mods.join(', ')}.`;
}

// SDXL: comma-separated booru-style tags. Lowercase. Multi-word tokens
// kebab-cased to look like the conventional positive-prompt vocab.
export function toSdxl(p: CanonicalPrompt): string {
  const subject = kebab(p.subject);
  const mods = p.modifiers.map(kebab).filter(Boolean);
  return [subject, ...mods].filter(Boolean).join(', ');
}

// DALL-E 3: narrative single-sentence framing. Avoids CLI flags; the model
// tends to follow descriptive prose more reliably than tag lists.
export function toDalle3(p: CanonicalPrompt): string {
  const subject = cleanSubject(p.subject);
  const mods = p.modifiers.map(cleanModifier).filter(Boolean);
  if (!subject && mods.length === 0) return '';
  const lead = subject ? `An image depicting ${subject.toLowerCase()}.` : '';
  const tail = mods.length > 0 ? ` ${mods.map((m) => capitalize(m) + '.').join(' ')}` : '';
  return (lead + tail).trim();
}

// Sora: cinematic framing. The default lead names a shot type so the
// generator gets a motion-friendly cue even when the canonical prompt is
// otherwise static.
export function toSora(p: CanonicalPrompt): string {
  const subject = cleanSubject(p.subject);
  const mods = p.modifiers.map(cleanModifier).filter(Boolean);
  const lead = subject
    ? `A slow tracking shot of ${subject.toLowerCase()}`
    : 'A slow tracking shot';
  return mods.length === 0 ? `${lead}.` : `${lead}. ${mods.join('. ')}.`;
}

function capitalize(s: string): string {
  if (!s) return s;
  return s[0]!.toUpperCase() + s.slice(1);
}

export function toDialect(prompt: CanonicalPrompt, dialect: Dialect): string {
  switch (dialect) {
    case 'midjourney':
      return toMidjourney(prompt);
    case 'flux':
      return toFlux(prompt);
    case 'sdxl':
      return toSdxl(prompt);
    case 'dalle3':
      return toDalle3(prompt);
    case 'sora':
      return toSora(prompt);
  }
}

export function toAllDialects(prompt: CanonicalPrompt): Record<Dialect, string> {
  const out = {} as Record<Dialect, string>;
  for (const d of DIALECTS) out[d] = toDialect(prompt, d);
  return out;
}
