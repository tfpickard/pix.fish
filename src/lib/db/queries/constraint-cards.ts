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
