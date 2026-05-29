import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../client';
import { constraintCards } from '../schema';
import type { ConstraintCard } from '../schema';

export const CARD_CATEGORIES = [
  'medium',
  'subject_archetype',
  'modifier',
  'mood',
  'idiom',
  'composition'
] as const;

export type CardCategory = (typeof CARD_CATEGORIES)[number];

export function isCardCategory(value: string): value is CardCategory {
  return (CARD_CATEGORIES as readonly string[]).includes(value);
}

// How many cards to sample per category for the dice UX. With a large pool
// (hundreds per category) shipping all of them as JSON is wasteful. 20 per
// category gives the client plenty of variety for the Fisher-Yates roll;
// rollDice picks n=3 per category from whatever subset it receives.
export const CARDS_PER_CATEGORY_PER_LOAD = 20;

export async function listCards(opts: {
  categories?: CardCategory[];
  activeOnly?: boolean;
} = {}): Promise<ConstraintCard[]> {
  const where = [];
  if (opts.categories && opts.categories.length > 0) {
    where.push(inArray(constraintCards.category, opts.categories));
  }
  if (opts.activeOnly !== false) {
    where.push(eq(constraintCards.active, true));
  }
  const query = db
    .select()
    .from(constraintCards)
    .orderBy(constraintCards.category, constraintCards.id);
  if (where.length === 0) return query;
  return query.where(where.length === 1 ? where[0] : and(...where));
}

// Sample up to `perCategory` random active cards from each category so the
// dice route doesn't ship the full pool to the client when the table grows
// large. The dice client receives this slice and does a client-side
// Fisher-Yates roll on it (rollDice / rollDicePerCategory), which still
// produces meaningful randomness as long as perCategory >> n-per-roll (3).
// We run one query per category in parallel rather than a LATERAL join
// because Drizzle's query builder doesn't support LATERAL without raw SQL
// and the category count is fixed and small (6).
export async function listCardsSampled(opts: {
  categories?: CardCategory[];
  perCategory?: number;
} = {}): Promise<ConstraintCard[]> {
  const cats = opts.categories ?? [...CARD_CATEGORIES];
  const perCat = opts.perCategory ?? CARDS_PER_CATEGORY_PER_LOAD;

  const batches = await Promise.all(
    cats.map((cat) =>
      db
        .select()
        .from(constraintCards)
        .where(and(eq(constraintCards.category, cat), eq(constraintCards.active, true)))
        .orderBy(sql`random()`)
        .limit(perCat)
    )
  );

  return batches.flat();
}

export async function upsertCard(input: {
  category: CardCategory;
  text: string;
  active?: boolean;
}): Promise<void> {
  await db
    .insert(constraintCards)
    .values({ category: input.category, text: input.text, active: input.active ?? true })
    .onConflictDoUpdate({
      target: [constraintCards.category, constraintCards.text],
      set: { active: input.active ?? true }
    });
}

export async function setCardActive(id: number, active: boolean): Promise<void> {
  await db.update(constraintCards).set({ active }).where(eq(constraintCards.id, id));
}

export async function countCardsByCategory(): Promise<Record<string, number>> {
  const rows = await db
    .select({
      category: constraintCards.category,
      n: sql<number>`count(*)::int`
    })
    .from(constraintCards)
    .where(eq(constraintCards.active, true))
    .groupBy(constraintCards.category);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.category] = Number(r.n);
  return out;
}
