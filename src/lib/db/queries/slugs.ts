import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '../client';
import { images } from '../schema';

/**
 * Resolve a base slug to a unique slug by appending -2, -3, ... as needed.
 * If `excludeImageId` is supplied, matches on that image don't count as collisions.
 */
export async function uniquifySlug(base: string, excludeImageId?: number): Promise<string> {
  if (!base) base = 'untitled';
  let candidate = base;
  let suffix = 2;
  // Cap the retry loop to avoid pathological cases.
  for (let i = 0; i < 500; i++) {
    const clauses = excludeImageId
      ? and(eq(images.slug, candidate), ne(images.id, excludeImageId))
      : eq(images.slug, candidate);
    const existing = await db.select({ id: images.id }).from(images).where(clauses).limit(1);
    if (existing.length === 0) return candidate;
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  throw new Error(`Could not uniquify slug "${base}" after 500 attempts.`);
}

export async function lookupRedirect(slug: string): Promise<string | null> {
  const rows = await db
    .select({ slug: images.slug })
    .from(images)
    .where(sql`${slug} = ANY(${images.slugHistory})`)
    .limit(1);
  return rows[0]?.slug ?? null;
}

export async function pushSlugToHistory(imageId: number, oldSlug: string) {
  if (!oldSlug) return;
  await db
    .update(images)
    .set({
      slugHistory: sql`CASE WHEN ${oldSlug} = ANY(${images.slugHistory}) THEN ${images.slugHistory} ELSE array_append(${images.slugHistory}, ${oldSlug}) END`
    })
    .where(eq(images.id, imageId));
}
