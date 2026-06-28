import { sql } from 'drizzle-orm';
import { db } from '../client';
import type { NsfwMode } from '@/lib/nsfw';

// Must match the caption embedding dimensionality (see embeddings.ts).
const EMBED_DIMENSIONS = 1536;

// Postgres "undefined_table" -- expected before the taste_votes migration runs.
function isMissingTable(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === '42P01';
}

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
    const arr = inner.split(',').map(Number);
    // Drop malformed vectors (wrong dim / NaN) so a single bad row can't make
    // tasteVector or searchByVector throw and break the whole page.
    if (arr.length === EMBED_DIMENSIONS && arr.every((n) => Number.isFinite(n))) {
      out.set(Number(r.image_id), arr);
    }
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

// --- Crowd votes ("most magnetic") -----------------------------------------
// Every quiz round is a pairwise vote: the picked image beat the passed-over
// one. These aggregate into a crowd ranking. Both helpers degrade gracefully:
// if the taste_votes table isn't migrated yet they no-op / return empty, so the
// rest of the feature works before `bun run db:push`.

// Which of the given ids are caption-embedded -- i.e. real, quiz-eligible
// nodes. The vote route uses this to reject forged pairs for images the quiz
// would never serve (the FK already forces real image ids; this additionally
// forbids ranking non-embedded ones). Ballot-stuffing among real images is the
// inherent property of any anonymous vote and is bounded by the rate limit and
// the min-appearances floor in topMagnetic.
export async function embeddedSubset(ids: number[]): Promise<Set<number>> {
  const out = new Set<number>();
  if (ids.length === 0) return out;
  const res = await db.execute<{ image_id: number }>(sql`
    SELECT image_id FROM embeddings
    WHERE kind = 'caption' AND subject_type = 'image' AND image_id IN (${idList(ids)})
  `);
  for (const r of res.rows) out.add(Number(r.image_id));
  return out;
}

export async function recordTasteVote(winnerId: number, loserId: number, ipHash: string): Promise<boolean> {
  if (!Number.isInteger(winnerId) || !Number.isInteger(loserId) || winnerId <= 0 || loserId <= 0 || winnerId === loserId) {
    return false;
  }
  try {
    await db.execute(sql`
      INSERT INTO taste_votes (winner_id, loser_id, ip_hash)
      VALUES (${winnerId}, ${loserId}, ${ipHash})
    `);
    return true;
  } catch (err) {
    // Silent no-op before the migration runs; only surface real failures.
    if (!isMissingTable(err)) console.warn('recordTasteVote failed', err);
    return false;
  }
}

// Images ranked by win rate, gated by NSFW mode. A min-appearances floor keeps
// a single lucky win off the top. Returns [] if the table is missing.
export async function topMagnetic(limit: number, nsfwMode: NsfwMode): Promise<{ id: number; wins: number; total: number }[]> {
  const lim = Math.min(Math.max(Math.trunc(limit), 1), 48);
  try {
    const res = await db.execute<{ id: number; wins: number; total: number }>(sql`
      WITH agg AS (
        SELECT id, sum(win)::int AS wins, count(*)::int AS total FROM (
          SELECT winner_id AS id, 1 AS win FROM taste_votes
          UNION ALL
          SELECT loser_id AS id, 0 AS win FROM taste_votes
        ) v GROUP BY id
      )
      SELECT i.id, agg.wins, agg.total
      FROM agg
      JOIN images i ON i.id = agg.id
      WHERE agg.total >= 3 ${nsfwClause(nsfwMode)}
      ORDER BY (agg.wins::float / agg.total) DESC, agg.wins DESC, i.id ASC
      LIMIT ${lim}
    `);
    return res.rows.map((r) => ({ id: Number(r.id), wins: Number(r.wins), total: Number(r.total) }));
  } catch (err) {
    // Silent empty before the migration runs; only surface real failures.
    if (!isMissingTable(err)) console.warn('topMagnetic failed', err);
    return [];
  }
}

// Most common palette colors across a set of images -- "your colors". palette
// is a text[] of hex strings; unnest + group to rank them.
export async function dominantPalette(ids: number[], limit = 6): Promise<string[]> {
  if (ids.length === 0) return [];
  const res = await db.execute<{ hex: string | null }>(sql`
    SELECT lower(hex) AS hex
    FROM images i, unnest(i.palette) AS hex
    WHERE i.id IN (${idList(ids)}) AND i.palette IS NOT NULL AND hex IS NOT NULL
    GROUP BY lower(hex)
    ORDER BY count(*) DESC
    LIMIT ${limit}
  `);
  return res.rows
    .map((r) => r.hex)
    .filter((h): h is string => typeof h === 'string' && /^#?[0-9a-f]{3,8}$/i.test(h));
}
