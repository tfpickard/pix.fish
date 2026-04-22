import { desc, sql } from 'drizzle-orm';
import { db } from '../client';
import { tags } from '../schema';

export type TagCount = { tag: string; count: number };

export async function tagCloud(limit = 64): Promise<TagCount[]> {
  const rows = await db
    .select({
      tag: tags.tag,
      count: sql<number>`count(*)::int`
    })
    .from(tags)
    .groupBy(tags.tag)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);
  return rows;
}
