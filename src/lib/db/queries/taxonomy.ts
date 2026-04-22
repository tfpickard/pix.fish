import { asc, eq } from 'drizzle-orm';
import { db } from '../client';
import { tagTaxonomy, type TaxonomyEntry } from '../schema';

export async function listTaxonomy(): Promise<TaxonomyEntry[]> {
  return db.select().from(tagTaxonomy).orderBy(asc(tagTaxonomy.sortOrder), asc(tagTaxonomy.tag));
}

export async function addTaxonomyTag(
  tag: string,
  category: string,
  sortOrder?: number
): Promise<TaxonomyEntry> {
  const [row] = await db
    .insert(tagTaxonomy)
    .values({ tag, category, sortOrder: sortOrder ?? 0 })
    .returning();
  return row;
}

export async function deleteTaxonomyTag(id: number): Promise<void> {
  await db.delete(tagTaxonomy).where(eq(tagTaxonomy.id, id));
}

export function formatTaxonomyForPrompt(entries: TaxonomyEntry[]): string {
  const byCategory = new Map<string, string[]>();
  for (const e of entries) {
    const cat = e.category || 'other';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(e.tag);
  }
  const lines: string[] = [];
  for (const [cat, list] of byCategory) {
    lines.push(`${cat}: ${list.join(', ')}`);
  }
  return lines.join('\n');
}
