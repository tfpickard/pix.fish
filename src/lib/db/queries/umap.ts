import { desc, sql } from 'drizzle-orm';
import { db } from '../client';
import { umapProjections } from '../schema';
import type { UmapProjection } from '../schema';

export type UmapPoint = { imageId: number; x: number; y: number };
export type UmapParams = { nNeighbors: number; minDist: number; kind: string };

export async function latestProjection(): Promise<UmapProjection | null> {
  const [row] = await db
    .select()
    .from(umapProjections)
    .orderBy(desc(umapProjections.createdAt))
    .limit(1);
  return row ?? null;
}

// How many projections to keep. Each row holds a complete JSON point array, so
// at the handler's 5000-point ceiling a row is not small. That was harmless
// while the only way to create one was an admin clicking recompute; now that
// every embedding write can schedule one, sustained uploading would insert a
// full copy of the atlas every couple of minutes forever. Nothing else in the
// codebase updates or prunes this table.
//
// A handful of rows is enough: only the newest is ever read (latestProjection),
// and the rest are there to eyeball a regression or roll back by hand.
const KEEP_PROJECTIONS = 10;

export async function saveProjection(params: UmapParams, points: UmapPoint[]): Promise<UmapProjection> {
  const [row] = await db
    .insert(umapProjections)
    .values({ pointCount: points.length, points, params })
    .returning();
  if (!row) throw new Error('saveProjection returned no row');

  // Prune outside the insert, best-effort: a projection that was written but
  // not tidied is a storage problem, while a failed prune that propagated
  // would fail the whole recompute and lose the projection instead.
  try {
    await db.execute(sql`
      DELETE FROM umap_projections
      WHERE id NOT IN (
        SELECT id FROM umap_projections ORDER BY created_at DESC LIMIT ${KEEP_PROJECTIONS}
      )
    `);
  } catch (err) {
    console.error('umap: failed to prune old projections', err);
  }

  return row;
}
