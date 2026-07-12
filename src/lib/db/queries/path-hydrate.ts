import { asc, inArray } from 'drizzle-orm';
import { db } from '../client';
import { images, captions, users } from '../schema';
import type { PathNode } from '@/lib/knn-path-types';
import type { NsfwMode } from '@/lib/nsfw';

// Hydrate image ids into PathNode[] for rendering routes, enforcing the
// visitor's NSFW mode and hiding archived rows. Mirrors the hydration in
// /connect + /api/path, kept here so desire-path surfaces reuse the exact same
// shape and gating (never ship a hidden blobUrl).

// Batched core: returns a map of VISIBLE nodes only, keyed by image id. Ids that
// are missing, archived, or hidden under the mode are simply absent. Used by the
// /paths index to hydrate every route's stops in one round-trip.
export async function hydrateVisibleNodeMap(
  ids: number[],
  nsfwMode: NsfwMode
): Promise<Map<number, PathNode>> {
  const out = new Map<number, PathNode>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;

  const [imageRows, captionRows] = await Promise.all([
    db
      .select({
        id: images.id,
        slug: images.slug,
        blobUrl: images.blobUrl,
        ownerId: images.ownerId,
        isNsfw: images.isNsfw,
        archivedAt: images.archivedAt
      })
      .from(images)
      .where(inArray(images.id, unique)),
    db
      .select({
        imageId: captions.imageId,
        text: captions.text,
        isSlugSource: captions.isSlugSource,
        variant: captions.variant
      })
      .from(captions)
      .where(inArray(captions.imageId, unique))
      .orderBy(asc(captions.imageId), asc(captions.variant))
  ]);

  const ownerIds = [...new Set(imageRows.map((r) => r.ownerId))];
  const userRows = ownerIds.length
    ? await db.select({ id: users.id, handle: users.handle }).from(users).where(inArray(users.id, ownerIds))
    : [];
  const handleByOwner = new Map(userRows.map((u) => [u.id, u.handle]));

  // Best caption per image: isSlugSource wins, else lowest variant.
  const captionByImage = new Map<number, string>();
  for (const c of captionRows) {
    if (!captionByImage.has(c.imageId)) captionByImage.set(c.imageId, c.text);
    else if (c.isSlugSource) captionByImage.set(c.imageId, c.text);
  }

  const visibleUnderMode = (isNsfw: boolean) =>
    nsfwMode === 'include' ? true : nsfwMode === 'only' ? isNsfw : !isNsfw;

  for (const r of imageRows) {
    if (r.archivedAt || !visibleUnderMode(r.isNsfw)) continue;
    out.set(r.id, {
      imageId: r.id,
      slug: r.slug,
      blobUrl: r.blobUrl,
      handle: handleByOwner.get(r.ownerId) ?? '',
      caption: captionByImage.get(r.id) ?? r.slug
    });
  }
  return out;
}

// Ordered hydration for a single route. `allVisible` is false when any stop was
// missing / archived / hidden, so the detail page can decide whether the partial
// corridor is worth rendering.
export async function hydrateRouteNodes(
  nodeIds: number[],
  nsfwMode: NsfwMode
): Promise<{ nodes: PathNode[]; allVisible: boolean }> {
  const map = await hydrateVisibleNodeMap(nodeIds, nsfwMode);
  const nodes: PathNode[] = [];
  let allVisible = true;
  for (const id of nodeIds) {
    const node = map.get(id);
    if (!node) {
      allVisible = false;
      continue;
    }
    nodes.push(node);
  }
  return { nodes, allVisible };
}

export function detailUrl(node: PathNode): string {
  return node.handle ? `/u/${node.handle}/${node.slug}` : `/${node.slug}`;
}
