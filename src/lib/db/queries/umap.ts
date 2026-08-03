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

function sameParams(a: UmapParams, b: Partial<UmapParams> | null | undefined): boolean {
  if (!b) return true; // no projection yet -- nothing to conflict with
  return a.nNeighbors === b.nNeighbors && a.minDist === b.minDist && a.kind === b.kind;
}

/**
 * Insert a projection, optionally only if the live configuration still matches
 * what the caller planned around.
 *
 * `requireCurrent` exists for automatic refreshes, which inherit their
 * parameters and must not overwrite an admin who retuned the atlas while the
 * fit was running. Checking that in the handler and then calling this
 * separately is not enough: the two statements leave a check-then-write window
 * in which the admin's insert can land. So the comparison and the insert
 * happen inside one transaction, serialized against every other projection
 * write by a transaction-scoped advisory lock -- the same primitive
 * enqueueIfNonePending uses, and for the same reason.
 *
 * Returns null when the guard rejected the write.
 */
export async function saveProjection(
  params: UmapParams,
  points: UmapPoint[],
  requireCurrent?: UmapParams | null
): Promise<UmapProjection | null> {
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('umap.projection')::bigint)`);

    if (requireCurrent) {
      const [live] = await tx
        .select()
        .from(umapProjections)
        .orderBy(desc(umapProjections.createdAt))
        .limit(1);
      if (!sameParams(requireCurrent, live?.params as Partial<UmapParams> | undefined)) return null;
    }

    const [inserted] = await tx
      .insert(umapProjections)
      .values({ pointCount: points.length, points, params })
      .returning();
    if (!inserted) throw new Error('saveProjection returned no row');
    return inserted;
  });

  if (!row) return null;

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
