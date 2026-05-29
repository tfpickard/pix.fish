import type { FillerBySlot } from '@/lib/db/queries/grammar';

// One generated skeleton prompt. `filledSlots` records the picked filler per
// slot so the UI can show the per-slot chips and freeze any of them on the
// next re-roll. `rendered` is the template with every [slot] substituted.
export type SkeletonPrompt = {
  template: string;
  slots: string[];
  filledSlots: Record<string, string>;
  frozenSlots: string[];
  rendered: string;
};

export type GrammarSlotInput = { template: string; frequency: number };

const SLOT_REGEX = /\[([a-z0-9_]+)\]/gi;

// Positional slots are named `<base>_<n>` (e.g. noun_1, noun_2) so each
// occurrence in a template is distinct and gets its own filler. The filler
// pool, though, is keyed by the BASE name (all noun positions draw from the
// same noun pool), so strip the trailing _<n> to look fillers up.
export function baseSlotName(name: string): string {
  return name.replace(/_\d+$/, '');
}

export function extractSlotNames(template: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const match of template.matchAll(SLOT_REGEX)) {
    const name = match[1]!.toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function pickWeighted<T>(items: T[], weight: (item: T) => number, rng: () => number): T {
  let total = 0;
  for (const item of items) total += Math.max(0, weight(item));
  if (total <= 0) return items[Math.floor(rng() * items.length)]!;
  let r = rng() * total;
  for (const item of items) {
    r -= Math.max(0, weight(item));
    if (r <= 0) return item;
  }
  return items[items.length - 1]!;
}

export function generateSkeleton(opts: {
  slots: GrammarSlotInput[];
  fillersBySlot: FillerBySlot;
  n: number;
  frozenSlots?: Record<string, string>;
  rng?: () => number;
}): SkeletonPrompt[] {
  const { slots, fillersBySlot, n } = opts;
  const rng = opts.rng ?? Math.random;
  const frozen = opts.frozenSlots ?? {};

  if (slots.length === 0) return [];

  const out: SkeletonPrompt[] = [];
  for (let i = 0; i < n; i++) {
    const template = pickWeighted(slots, (s) => s.frequency, rng).template;
    const slotNames = extractSlotNames(template);
    const filledSlots: Record<string, string> = {};
    const frozenNames: string[] = [];

    for (const name of slotNames) {
      const frozenValue = frozen[name];
      if (frozenValue !== undefined && frozenValue !== '') {
        filledSlots[name] = frozenValue;
        frozenNames.push(name);
        continue;
      }
      // Exact name first (supports flat, non-positional legacy grammars and
      // LLM-renamed bases), then fall back to the positional base pool.
      const candidates = fillersBySlot[name] ?? fillersBySlot[baseSlotName(name)];
      if (!candidates || candidates.length === 0) {
        // No fillers for this slot yet -- leave the bracketed placeholder
        // visible so the owner can see which slot is empty rather than
        // silently dropping it.
        filledSlots[name] = `[${name}]`;
        continue;
      }
      const choice = pickWeighted(candidates, (c) => c.weight, rng);
      filledSlots[name] = choice.filler;
    }

    out.push({
      template,
      slots: slotNames,
      filledSlots,
      frozenSlots: frozenNames,
      rendered: renderTemplate(template, filledSlots)
    });
  }
  return out;
}

export function renderTemplate(template: string, filledSlots: Record<string, string>): string {
  return template.replace(SLOT_REGEX, (_, name: string) => {
    const key = name.toLowerCase();
    return filledSlots[key] ?? `[${key}]`;
  });
}

// Used by the freeze-slot UX: parse "slot_name:filler,slot_name:filler" from
// a URL query param into the frozenSlots map. Tolerant of empty values.
export function parseFreezeParam(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf(':');
    if (idx < 1) continue;
    const name = pair.slice(0, idx).trim().toLowerCase();
    const value = pair.slice(idx + 1).trim();
    if (!name || !value) continue;
    out[name] = value;
  }
  return out;
}
