import { sql } from 'drizzle-orm';
import { db } from '../client';
import type { NsfwMode } from '@/lib/nsfw';

// Data layer for /taste -- the aesthetic-vector quiz. Reuses the same caption
// embedding space as search/connect/daily; the only new reads are random
// quiz seeds, a batch vector fetch, and tag/palette aggregation over a set of
// images for the result "signature".

function nsfwClause(nsfwMode: NsfwMode) {
  return nsfwMode === 'only' ? sql`AND i.is_nsfw = true` :
    nsfwMode === 'include' ? sql`` :
    sql`AND i.is_nsfw = false`;
}

// Helper: a comma-separated, parameterized id list for an IN (...) clause.
function idList(ids: number[]) {
  return sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `
  );
}

// Random caption-embedded image ids, gated to the visitor's NSFW mode. Used to
// seed the quiz pairs. Randomized per load -- the quiz is exploratory, not a
// deterministic daily.
export async function getRandomEmbeddedImageIds(count: number, nsfwMode: NsfwMode): Promise<number[]> {
  const limit = Math.min(Math.max(Math.trunc(count), 1), 64);
  const res = await db.execute<{ id: number }>(sql`
    SELECT i.id
    FROM images i
    JOIN embeddings e ON e.image_id = i.id AND e.kind = 'caption' AND e.subject_type = 'image'
    WHERE true ${nsfwClause(nsfwMode)}
    ORDER BY random()
    LIMIT ${limit}
  `);
  return res.rows.map((r) => Number(r.id));
}

// Batch-fetch caption embeddings for a set of image ids. Used to build the
// taste vector from the visitor's picks. Note: the vectors are not visual
// content, so reading them for any id (even NSFW) leaks nothing -- the result
// only ever *renders* NSFW-gated matches.
export async function getCaptionVectorsForIds(ids: number[]): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>();
  if (ids.length === 0) return out;
  const res = await db.execute<{ image_id: number; vec: string }>(sql`
    SELECT image_id, vec::text AS vec
    FROM embeddings
    WHERE kind = 'caption' AND subject_type = 'image' AND image_id IN (${idList(ids)})
  `);
  for (const r of res.rows) {
    const inner = r.vec.startsWith('[') ? r.vec.slice(1, -1) : r.vec;
    out.set(Number(r.image_id), inner.split(',').map(Number));
  }
  return out;
}

// Most common tags across a set of images -- the visitor's "aesthetic
// signature". Run over the NSFW-gated match set, never the raw picks.
export async function topTagsForImages(ids: number[], limit = 8): Promise<{ tag: string; count: number }[]> {
  if (ids.length === 0) return [];
  const res = await db.execute<{ tag: string; count: number }>(sql`
    SELECT tag, count(*)::int AS count
    FROM tags
    WHERE image_id IN (${idList(ids)})
    GROUP BY tag
    ORDER BY count(*) DESC, tag ASC
    LIMIT ${limit}
  `);
  return res.rows.map((r) => ({ tag: r.tag, count: Number(r.count) }));
}

// Most common palette colors across a set of images -- "your colors". palette
// is a text[] of hex strings; unnest + group to rank them.
export async function dominantPalette(ids: number[], limit = 6): Promise<string[]> {
  if (ids.length === 0) return [];
  const res = await db.execute<{ hex: string }>(sql`
    SELECT lower(hex) AS hex
    FROM images i, unnest(i.palette) AS hex
    WHERE i.id IN (${idList(ids)}) AND i.palette IS NOT NULL
    GROUP BY lower(hex)
    ORDER BY count(*) DESC
    LIMIT ${limit}
  `);
  return res.rows.map((r) => r.hex).filter((h) => /^#?[0-9a-f]{3,8}$/i.test(h));
}
