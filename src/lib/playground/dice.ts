import type { ConstraintCard } from '@/lib/db/schema';

export type DiceRoll = { id: number; category: string; text: string };

// Pure function: take a pool of active cards, return N random picks. Caller
// owns the DB read so the lib stays trivially testable and the route can
// scope the pool (active-only, category filter, etc.) however it wants.
export function rollDice(opts: {
  pool: ConstraintCard[];
  n: number;
  rng?: () => number;
}): DiceRoll[] {
  const rng = opts.rng ?? Math.random;
  const n = Math.max(0, Math.min(opts.n, opts.pool.length));
  if (n === 0) return [];
  // Fisher-Yates shuffle the indices and take the first n. Avoids picking
  // duplicates without the O(n^2) "pick until unique" pattern.
  const indices = opts.pool.map((_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [indices[i], indices[j]] = [indices[j]!, indices[i]!];
  }
  return indices.slice(0, n).map((idx) => {
    const card = opts.pool[idx]!;
    return { id: card.id, category: card.category, text: card.text };
  });
}

// Helper for "roll k per category". Useful for the dice section UX where
// the owner toggles a category and wants a fresh row of cards just for it.
export function rollDicePerCategory(opts: {
  pool: ConstraintCard[];
  perCategory: number;
  rng?: () => number;
}): DiceRoll[] {
  const byCategory = new Map<string, ConstraintCard[]>();
  for (const card of opts.pool) {
    const list = byCategory.get(card.category) ?? [];
    list.push(card);
    byCategory.set(card.category, list);
  }
  const out: DiceRoll[] = [];
  for (const [, cards] of byCategory) {
    out.push(...rollDice({ pool: cards, n: opts.perCategory, rng: opts.rng }));
  }
  return out;
}
