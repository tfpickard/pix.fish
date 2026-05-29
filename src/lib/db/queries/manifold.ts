import { desc } from 'drizzle-orm';
import { db } from '../client';
import { manifoldProjections } from '../schema';
import type { ManifoldProjection } from '../schema';

export type ManifoldPoint = { imageId: number; x: number; y: number; z: number };

export type ManifoldParams = {
  nNeighbors: number;
  minDist: number;
  seed: number;
  kind: string;
};

export async function latestManifold(): Promise<ManifoldProjection | null> {
  const [row] = await db
    .select()
    .from(manifoldProjections)
    .orderBy(desc(manifoldProjections.createdAt))
    .limit(1);
  return row ?? null;
}

export async function saveManifold(
  seed: number,
  params: ManifoldParams,
  points: ManifoldPoint[]
): Promise<ManifoldProjection> {
  const [row] = await db
    .insert(manifoldProjections)
    .values({
      seed,
      pointCount: points.length,
      points,
      params: params as Record<string, unknown>
    })
    .returning();
  if (!row) throw new Error('saveManifold returned no row');
  return row;
}
