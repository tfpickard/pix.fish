import { and, eq, ne, sql } from 'drizzle-orm';
import { db } from '../client';
import { images } from '../schema';

/**
 * Resolve a base slug to a unique slug WITHIN one user's namespace by
 * appending -2, -3, ... as needed. Multi-user: two users can both own
 * `/u/<them>/sunset` because the unique index on images is
 * (owner_id, slug), so we only check collisions inside the same owner.
 *
 * If `excludeImageId` is supplied, matches on that image don't count as
 * collisions (used during slug edits on an existing row).
 */
export async function uniquifySlug(
  base: string,
  ownerId: string,
  excludeImageId?: number
): Promise<string> {
  if (!base) base = 'untitled';
  let candidate = base;
  let suffix = 2;
  for (let i = 0; i < 500; i++) {
    const baseClause = and(eq(images.ownerId, ownerId), eq(images.slug, candidate));
    const clauses = excludeImageId
      ? and(baseClause, ne(images.id, excludeImageId))
      : baseClause;
    const existing = await db.select({ id: images.id }).from(images).where(clauses).limit(1);
    if (existing.length === 0) return candidate;
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  throw new Error(`Could not uniquify slug "${base}" for owner ${ownerId} after 500 attempts.`);
}

// Returns the *current* slug an old slug should redirect to, scanning the
// global slug_history index. Cross-owner: if user A renamed `/u/a/sunset`
// to `/u/a/sunset-pm`, the old `sunset` history entry routes back to A's
// row, not B's. The GIN index on slug_history makes the ANY() lookup cheap.
export async function lookupRedirect(
  slug: string
): Promise<{ slug: string; ownerId: string } | null> {
  const rows = await db
    .select({ slug: images.slug, ownerId: images.ownerId })
    .from(images)
    .where(sql`${slug} = ANY(${images.slugHistory})`)
    .limit(1);
  return rows[0] ?? null;
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
