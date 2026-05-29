import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../client';
import { imageLineage, images } from '../schema';

// The transaction handle drizzle hands to a db.transaction callback. Edges are
// written inside the same transaction as the child image insert so a partial
// failure leaves no orphan edges (see src/app/api/images/route.ts).
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type LineageNode = { id: number; slug: string; blobUrl: string };
export type LineageEdge = {
  childImageId: number;
  parentImageId: number;
  promptUsed: string | null;
  dialectUsed: string | null;
};
export type LineageGraph = { nodes: LineageNode[]; edges: LineageEdge[] };

// Resolve a set of parent slugs to image ids the uploader actually owns. Slugs
// that do not exist or belong to someone else are silently dropped -- the
// upload still succeeds, just without those edges. Returns ids in no
// particular order.
export async function resolveOwnedImageIdsBySlugs(
  ownerId: string,
  slugs: string[]
): Promise<number[]> {
  if (slugs.length === 0) return [];
  const rows = await db
    .select({ id: images.id })
    .from(images)
    .where(and(eq(images.ownerId, ownerId), inArray(images.slug, slugs)));
  return rows.map((r) => r.id);
}

// Insert parent -> child edges. Self-edges are skipped; duplicates collide on
// the (child, parent) unique index and are ignored so re-uploads are safe.
export async function addLineageEdges(
  tx: Tx,
  args: {
    childImageId: number;
    parentImageIds: number[];
    promptUsed?: string | null;
    dialectUsed?: string | null;
  }
): Promise<void> {
  const parents = [...new Set(args.parentImageIds)].filter((p) => p !== args.childImageId);
  if (parents.length === 0) return;
  await tx
    .insert(imageLineage)
    .values(
      parents.map((parentImageId) => ({
        childImageId: args.childImageId,
        parentImageId,
        promptUsed: args.promptUsed ?? null,
        dialectUsed: args.dialectUsed ?? null
      }))
    )
    .onConflictDoNothing({
      target: [imageLineage.childImageId, imageLineage.parentImageId]
    });
}

// The whole lineage graph for one owner: every edge whose child belongs to the
// owner, plus the node metadata needed to render and link each image. Parents
// are always the owner's own images too (the upload form only offers the
// owner's gallery), so filtering on the child's owner is sufficient.
export async function getLineageGraph(ownerId: string): Promise<LineageGraph> {
  const child = images;
  const edgeRows = await db
    .select({
      childImageId: imageLineage.childImageId,
      parentImageId: imageLineage.parentImageId,
      promptUsed: imageLineage.promptUsed,
      dialectUsed: imageLineage.dialectUsed
    })
    .from(imageLineage)
    .innerJoin(child, eq(imageLineage.childImageId, child.id))
    .where(eq(child.ownerId, ownerId));

  if (edgeRows.length === 0) return { nodes: [], edges: [] };

  const nodeIds = [
    ...new Set(edgeRows.flatMap((e) => [e.childImageId, e.parentImageId]))
  ];
  const nodeRows = await db
    .select({ id: images.id, slug: images.slug, blobUrl: images.blobUrl })
    .from(images)
    .where(inArray(images.id, nodeIds));

  return { nodes: nodeRows, edges: edgeRows };
}
