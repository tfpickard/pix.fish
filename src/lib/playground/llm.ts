import { getProvider, loadUserProviderKeys } from '@/lib/ai';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { getSiteAdminId } from '@/lib/db/queries/users';
import type { ImageWithRelations } from '@/lib/db/queries/images';
import type { FillerBySlot } from '@/lib/db/queries/grammar';
import type { GrammarSlot } from '@/lib/db/schema';

// Thin wrapper over the configured text provider for playground generators.
// All of them want the same thing: the descriptions provider's text-only
// completion, routed through the usual config + per-user key resolution. We
// use the descriptions field (not captions) because these features produce
// free-form prose prompts, and descriptions is the field breed.ts already
// proved works for text-only generation. Returns null when the resolved
// provider has no usable key -- callers surface that as a warning rather than
// a hard error, matching the rest of the codebase's "skip the field" stance.
export type TextRunner = {
  name: string;
  model: string;
  run: (prompt: string) => Promise<string>;
};

export async function getPlaygroundTextRunner(userId?: string): Promise<TextRunner | null> {
  const cfg = await loadAiConfig();
  const keys = await loadUserProviderKeys(userId ?? getSiteAdminId());
  const provider = getProvider('descriptions', cfg, keys);
  if (!provider || !provider.text) return null;
  const text = provider.text.bind(provider);
  return { name: provider.name, model: provider.model, run: (p: string) => text(p) };
}

// Serialise a handful of images into prompt-friendly text. Mirrors the private
// helper in breed.ts; kept separate so the playground does not import breed
// internals. Captions only -- the playground prompts care about the gallery's
// voice, not its tag soup.
export function formatCaptionsForPrompt(images: ImageWithRelations[]): string {
  if (images.length === 0) return '(none)';
  return images
    .map((img, idx) => {
      const caps = img.captions
        .slice(0, 2)
        .map((c) => c.text)
        .filter(Boolean);
      return `[${idx + 1}] ${caps.join(' | ')}`;
    })
    .join('\n');
}

// Compact rendering of the mined grammar for the equalizer's {{grammar_style}}
// placeholder: the most frequent templates plus a few fillers per slot. Kept
// small so it frames the model's voice without blowing the prompt budget.
export function formatGrammarStyle(
  slots: GrammarSlot[],
  fillersBySlot: FillerBySlot,
  opts: { maxTemplates?: number; fillersPerSlot?: number } = {}
): string {
  const maxTemplates = opts.maxTemplates ?? 8;
  const fillersPerSlot = opts.fillersPerSlot ?? 5;
  const templateLines = slots
    .slice(0, maxTemplates)
    .map((s) => `  - ${s.template}`)
    .join('\n');
  const fillerLines = Object.entries(fillersBySlot)
    .map(([slot, fillers]) => {
      const top = fillers
        .slice(0, fillersPerSlot)
        .map((f) => f.filler)
        .join(', ');
      return `  - [${slot}]: ${top}`;
    })
    .join('\n');
  return `Frequent templates:\n${templateLines || '  (none)'}\n\nTypical fillers:\n${fillerLines || '  (none)'}`;
}

// The walk_step prompt returns {"prompt": "..."}. Parse it defensively:
// strip a code fence, JSON.parse, take .prompt; fall back to the raw trimmed
// text so a model that ignores the JSON instruction still yields something.
export function parsePromptJson(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const body = fence ? fence[1]!.trim() : trimmed;
  try {
    const obj = JSON.parse(body) as { prompt?: unknown };
    if (typeof obj.prompt === 'string' && obj.prompt.trim()) return obj.prompt.trim();
  } catch {
    // not JSON -- fall through to raw text
  }
  return body;
}
