import { sql } from 'drizzle-orm';
import { db } from '../client';
import type { NsfwMode } from '@/lib/nsfw';

// Data layer for /drift -- the steerable latent walk. Reuses the same caption
// embedding space as search/connect/daily/taste; the only drift-specific reads
// are seeding a valid start image and validating a replay/branch id list. The
// per-step vector search itself goes through the shared, already-gated
// searchByVector (archived + NSFW filtered at the query layer).

function nsfwClause(nsfwMode: NsfwMode) {
  return nsfwMode === 'only' ? sql`AND i.is_nsfw = true` :
    nsfwMode === 'include' ? sql`` :
    sql`AND i.is_nsfw = false`;
}

function idList(ids: number[]) {
  return sql.join(ids.map((id) => sql`${id}`), sql`, `);
}

// A valid drift seed: caption-embedded, not archived, allowed by NSFW mode.
// Prefers `preferId` (a shared/branch start) when it qualifies, else a random
// in-scope image -- so a crafted ?from= can never start a drift on a hidden row.
export async function seedDriftImage(
  preferId: number | null,
  nsfwMode: NsfwMode
): Promise<number | null> {
  if (preferId && Number.isInteger(preferId) && preferId > 0) {
    const r = await db.execute<{ id: number }>(sql`
      SELECT i.id
      FROM images i
      JOIN embeddings e ON e.image_id = i.id AND e.kind = 'caption' AND e.subject_type = 'image'
      WHERE i.id = ${preferId} AND i.archived_at IS NULL ${nsfwClause(nsfwMode)}
      LIMIT 1
    `);
    if (r.rows[0]) return Number(r.rows[0].id);
  }
  const r = await db.execute<{ id: number }>(sql`
    SELECT i.id
    FROM images i
    JOIN embeddings e ON e.image_id = i.id AND e.kind = 'caption' AND e.subject_type = 'image'
    WHERE i.archived_at IS NULL ${nsfwClause(nsfwMode)}
    ORDER BY random()
    LIMIT 1
  `);
  return r.rows[0] ? Number(r.rows[0].id) : null;
}

// Which of the given ids are a valid drift frame -- embedded, not archived,
// allowed by NSFW mode. A replay/branch URL (?d=12,45,...) is filtered through
// this before hydrating, so a crafted id list can't smuggle an archived or
// NSFW-hidden image into playback (hydrateNodes itself does not gate).
export async function activeDriftIds(ids: number[], nsfwMode: NsfwMode): Promise<Set<number>> {
  const out = new Set<number>();
  const clean = ids.filter((n) => Number.isInteger(n) && n > 0);
  if (clean.length === 0) return out;
  const r = await db.execute<{ id: number }>(sql`
    SELECT i.id
    FROM images i
    JOIN embeddings e ON e.image_id = i.id AND e.kind = 'caption' AND e.subject_type = 'image'
    WHERE i.id IN (${idList(clean)}) AND i.archived_at IS NULL ${nsfwClause(nsfwMode)}
  `);
  for (const row of r.rows) out.add(Number(row.id));
  return out;
}
