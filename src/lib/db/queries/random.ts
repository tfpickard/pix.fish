import { and, eq, isNull, sql } from 'drizzle-orm';
import type { NsfwMode } from '@/lib/nsfw';
import { db } from '../client';
import { images, type Image } from '../schema';
import { nsfwPredicate } from './images';

// Picks one random image respecting the same NSFW gating the public stream
// uses, and additionally excluding archived + basement rows -- both are meant
// to be hidden from public surfaces, so a random endpoint must never surface
// them. `ORDER BY random() LIMIT 1` is fine at this table's scale (the same
// idiom is used by queries/drift.ts and taste.ts). Returns null when no row
// matches (empty gallery, or an 'only' filter with no NSFW rows).
export async function pickRandomImageRow(opts: {
  nsfwMode: NsfwMode;
}): Promise<Image | null> {
  const nsfw = nsfwPredicate(opts.nsfwMode);
  // Always hidden from the random surface regardless of NSFW mode.
  const visible = and(isNull(images.archivedAt), eq(images.basement, false));
  const where = nsfw ? and(visible, nsfw) : visible;
  const [row] = await db
    .select()
    .from(images)
    .where(where)
    .orderBy(sql`random()`)
    .limit(1);
  return row ?? null;
}
