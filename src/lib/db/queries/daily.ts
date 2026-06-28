import { asc, inArray, sql } from 'drizzle-orm';
import { db } from '../client';
import { images, captions, users } from '../schema';
import {
  getEdgesForNodes,
  getEdgesForNodesExcludingNsfw,
  getEdgesForNodesNsfwOnly,
  type KnnNeighbor
} from './knn';
import type { NsfwMode } from '@/lib/nsfw';
import type { PathNode } from '@/lib/knn-path-types';

// Data layer for the /daily puzzle. It assembles the NSFW-scoped kNN subgraph
// (node ids + adjacency + image metadata) for a single day so the whole game
// can run client-side from one embedded payload -- no per-move API.

// Image ids that are kNN graph nodes (caption-embedded), not archived, AND
// visible under the visitor's NSFW mode (archived rows keep their embedding, so
// without the archived_at gate a deleted image could resurface as a puzzle
// node). Ordered by id so a date-seeded shuffle is deterministic.
export async function getGraphNodeIds(nsfwMode: NsfwMode): Promise<number[]> {
  const nsfwClause =
    nsfwMode === 'only' ? sql`AND i.is_nsfw = true` :
    nsfwMode === 'include' ? sql`` :
    sql`AND i.is_nsfw = false`;
  const res = await db.execute<{ id: number }>(sql`
    SELECT DISTINCT i.id
    FROM images i
    JOIN embeddings e ON e.image_id = i.id AND e.kind = 'caption'
    WHERE i.archived_at IS NULL ${nsfwClause}
    ORDER BY i.id
  `);
  return res.rows.map((r) => Number(r.id));
}

export type Adjacency = Map<number, KnnNeighbor[]>;

// Adjacency for the scoped node set, using the same NSFW-aware edge loaders as
// /connect so the graph the player walks matches what they're allowed to see.
// Destinations are intersected with the in-scope set as a final guard.
export async function getScopedAdjacency(nodeIds: number[], nsfwMode: NsfwMode): Promise<Adjacency> {
  const adj: Adjacency = new Map();
  if (nodeIds.length === 0) return adj;
  const loader =
    nsfwMode === 'only' ? getEdgesForNodesNsfwOnly :
    nsfwMode === 'include' ? getEdgesForNodes :
    getEdgesForNodesExcludingNsfw;
  const raw = await loader(nodeIds);
  const inScope = new Set(nodeIds);
  for (const id of nodeIds) {
    adj.set(id, (raw.get(id) ?? []).filter((e) => inScope.has(e.dstId)));
  }
  return adj;
}

// Hydrate ids -> PathNode (slug, blobUrl, owner handle, canonical caption).
// Same canonical-caption rule as /api/path: prefer isSlugSource, else lowest
// variant, else the slug. Returned as a Map so the page can build a plain
// id->node record for the client payload.
export async function hydrateNodes(ids: number[]): Promise<Map<number, PathNode>> {
  const out = new Map<number, PathNode>();
  if (ids.length === 0) return out;

  const [imageRows, captionRows] = await Promise.all([
    db
      .select({ id: images.id, slug: images.slug, blobUrl: images.blobUrl, ownerId: images.ownerId })
      .from(images)
      .where(inArray(images.id, ids)),
    db
      .select({ imageId: captions.imageId, text: captions.text, isSlugSource: captions.isSlugSource, variant: captions.variant })
      .from(captions)
      .where(inArray(captions.imageId, ids))
      .orderBy(asc(captions.imageId), asc(captions.variant))
  ]);

  const ownerIds = [...new Set(imageRows.map((r) => r.ownerId))];
  const userRows = ownerIds.length
    ? await db.select({ id: users.id, handle: users.handle }).from(users).where(inArray(users.id, ownerIds))
    : [];
  const handleByOwner = new Map(userRows.map((u) => [u.id, u.handle]));

  const captionByImage = new Map<number, string>();
  for (const c of captionRows) {
    if (!captionByImage.has(c.imageId)) captionByImage.set(c.imageId, c.text);
    else if (c.isSlugSource) captionByImage.set(c.imageId, c.text);
  }

  for (const img of imageRows) {
    out.set(img.id, {
      imageId: img.id,
      slug: img.slug,
      blobUrl: img.blobUrl,
      handle: handleByOwner.get(img.ownerId) ?? '',
      caption: captionByImage.get(img.id) ?? img.slug
    });
  }
  return out;
}
