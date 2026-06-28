import { sql } from 'drizzle-orm';
import { db } from '../client';
import { getCaptionVectorsForIds } from './taste';
import { searchByVector } from './embeddings';
import { meanVector, normalize } from '@/lib/taste/vector';
import type { NsfwMode } from '@/lib/nsfw';

// Data layer for /fuse -- "image alchemy". Combining two images means taking the
// centroid of their caption embeddings and surfacing the single real image
// nearest that midpoint: the specimen that best blends both vibes. Deterministic
// given the corpus (searchByVector orders by distance), so a recipe (A + B = C)
// is stable and shareable. Reuses the same gated primitives as drift/taste --
// nothing here renders an image the visitor isn't allowed to see.

function nsfwClause(nsfwMode: NsfwMode) {
  return nsfwMode === 'only' ? sql`AND i.is_nsfw = true` :
    nsfwMode === 'include' ? sql`` :
    sql`AND i.is_nsfw = false`;
}

function idList(ids: number[]) {
  return sql.join(ids.map((id) => sql`${id}`), sql`, `);
}

// Fuse two images -> the image id nearest the centroid of their caption
// embeddings, excluding the two parents. Gated via searchByVector (archived +
// NSFW filtered at the query layer). Returns null if either parent has no usable
// embedding, or nothing distinct ranks (tiny corpus). Deterministic: the same
// (a, b) always yields the same fusion, so recipes are stable and shareable.
export async function fusePair(aId: number, bId: number, nsfwMode: NsfwMode): Promise<number | null> {
  if (aId === bId) return null;
  const vecs = await getCaptionVectorsForIds([aId, bId]);
  const va = vecs.get(aId);
  const vb = vecs.get(bId);
  if (!va || !vb) return null;
  const centroid = meanVector([va, vb]);
  if (!centroid) return null;
  // A small band, then the nearest that isn't one of the parents.
  const ranked = await searchByVector(normalize(centroid), { limit: 8, kind: 'caption', nsfwMode });
  return ranked.map((m) => m.imageId).find((id) => id !== aId && id !== bId) ?? null;
}

// Which of the given ids are a valid fuse element -- caption-embedded, not
// archived, allowed by NSFW mode. A shared board URL (?have=12,45,...) and the
// /api/fuse parents are filtered through this before use, so a crafted id list
// can't smuggle a hidden image onto the board.
export async function activeFuseIds(ids: number[], nsfwMode: NsfwMode): Promise<Set<number>> {
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
