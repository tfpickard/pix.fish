import { desc } from 'drizzle-orm';
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

export async function saveProjection(params: UmapParams, points: UmapPoint[]): Promise<UmapProjection> {
  const [row] = await db
    .insert(umapProjections)
    .values({ pointCount: points.length, points, params })
    .returning();
  if (!row) throw new Error('saveProjection returned no row');
  return row;
}
