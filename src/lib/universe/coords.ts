import { latestManifold } from '@/lib/db/queries/manifold';
import { latestProjection } from '@/lib/db/queries/umap';

// Lore coords are inherited from the parent image: a dossier sits where its
// specimen sits in the manifold. Rather than run a parallel UMAP for lore, we
// stamp each fragment with its image's coords from the latest 2D (UMAP) and 3D
// (manifold) projections. This map is built once and handed to the reducers.

export type Coords = { x: number | null; y: number | null; z: number | null };
export type CoordsMap = Map<number, Coords>;

export async function buildCoordsMap(): Promise<CoordsMap> {
  const map: CoordsMap = new Map();

  const umap = await latestProjection().catch(() => null);
  // umap_projections.points is an untyped jsonb column; its runtime shape is
  // [{ imageId, x, y }] (see queries/umap.ts UmapPoint).
  const umapPoints = (umap?.points as Array<{ imageId: number; x: number; y: number }> | undefined) ?? [];
  for (const p of umapPoints) {
    map.set(p.imageId, { x: p.x, y: p.y, z: null });
  }

  const manifold = await latestManifold().catch(() => null);
  if (manifold?.points) {
    for (const p of manifold.points) {
      const cur = map.get(p.imageId) ?? { x: null, y: null, z: null };
      // Prefer the 2D UMAP x/y when present (it is the canonical /map layout);
      // always take z from the manifold.
      map.set(p.imageId, { x: cur.x ?? p.x, y: cur.y ?? p.y, z: p.z });
    }
  }

  return map;
}

export function coordsFor(map: CoordsMap, imageId: number): Coords {
  return map.get(imageId) ?? { x: null, y: null, z: null };
}
