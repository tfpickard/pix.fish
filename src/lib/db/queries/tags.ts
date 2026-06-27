import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../client';
import { images, tags } from '../schema';
import type { NsfwMode } from '@/lib/nsfw';

export type TagCount = { tag: string; count: number };

// `nsfwMode` scopes the counts to the same image set the caller will surface,
// mirroring the is_nsfw gate that searchByVector applies. Omit it for the
// original global cloud. Pass the visitor's mode wherever the tags become
// clickable queries, so a tag that lives only on NSFW images can't leak its
// label to an opted-out visitor (or launch a guaranteed-empty search).
export async function tagCloud(limit = 64, nsfwMode?: NsfwMode): Promise<TagCount[]> {
  // No mode, or 'include' -> count across every image (the original behavior).
  if (!nsfwMode || nsfwMode === 'include') {
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
  // 'hide' -> SFW only; 'only' -> NSFW only. Matches searchByVector's gate so
  // the suggestions stay consistent with the results they launch.
  const rows = await db
    .select({
      tag: tags.tag,
      count: sql<number>`count(*)::int`
    })
    .from(tags)
    .innerJoin(images, eq(images.id, tags.imageId))
    .where(eq(images.isNsfw, nsfwMode === 'only'))
    .groupBy(tags.tag)
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
