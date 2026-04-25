import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../client';
import { images, tags } from '../schema';

export type TagCount = { tag: string; count: number };

export async function tagCloud(limit = 64): Promise<TagCount[]> {
  const rows = await db
    .select({
      tag: tags.tag,
      count: sql<number>`count(*)::int`
    })
    .from(tags)
    .groupBy(tags.tag)
    // Skip singletons -- a tag that appears on only one image is noise in
    // the cloud. Visitors can still discover it via the image detail page.
    .having(sql`count(*) > 1`)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);
  return rows;
}

// Per-owner variant for /u/<handle> profile pages. Joins tags->images and
// scopes the count to one user. Singletons are kept here -- a per-user
// gallery is small enough that any tag is interesting.
export async function tagCloudByOwner(ownerId: string, limit = 64): Promise<TagCount[]> {
  const rows = await db
    .select({
      tag: tags.tag,
      count: sql<number>`count(*)::int`
    })
    .from(tags)
    .innerJoin(images, eq(images.id, tags.imageId))
    .where(eq(images.ownerId, ownerId))
    .groupBy(tags.tag)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);
  return rows;
}
