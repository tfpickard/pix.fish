import { audiences, extras, lengths, voices, type Fragments } from './fragments';

// Minimal templates keyed by prompt family. The composer concatenates the
// picked fragments after the family opener and before the JSON instruction
// so placeholder semantics (`{{tag_taxonomy}}`, `{{existing_caption}}`, etc.)
// are preserved exactly where resolvePrompt expects them.
const FAMILY_OPENERS = {
  caption: 'You are generating captions for a personal image gallery.',
  description: 'You are writing descriptions for a personal image gallery.',
  tags: 'You are generating tags for a personal image gallery.'
} as const;

const FAMILY_CLOSERS = {
  caption: `If the owner has provided a hint caption, treat it as a reference anchor -- do not quote it.
Owner hint (may be blank): "{{existing_caption}}"

Return ONLY valid JSON in this exact shape, with no prose around it:
{
  "variant1": "<variant 1 caption>",
  "variant2": "<variant 2 caption>",
  "variant3": "<variant 3 caption>"
}`,
  description: `If the owner has provided a hint caption, treat it as a reference anchor.
Owner hint (may be blank): "{{existing_caption}}"

Return ONLY valid JSON in this exact shape:
{
  "variant1": "<description 1>",
  "variant2": "<description 2>",
  "variant3": "<description 3>"
}`,
  tags: `Use the structural tags from this taxonomy when they fit:
{{tag_taxonomy}}

Return ONLY valid JSON in this shape:
{ "tags": [{ "tag": "example", "source": "taxonomy", "confidence": 0.9 }] }`
} as const;

export type Family = keyof typeof FAMILY_OPENERS;

export function compose(family: Family, f: Fragments): string {
  const lines: string[] = [FAMILY_OPENERS[family]];
  if (f.voice) lines.push(voices[f.voice]);
  if (f.length) lines.push(lengths[f.length]);
  if (f.audience) lines.push(audiences[f.audience]);
  if (f.extras && f.extras.length > 0) {
    for (const e of f.extras) lines.push(extras[e]);
  }
  // House style invariant; prompts in this repo never use em dashes.
  lines.push('Do not use em dashes. Use commas, periods, or "--".');
  lines.push('');
  lines.push(FAMILY_CLOSERS[family]);
  return lines.join('\n');
}
