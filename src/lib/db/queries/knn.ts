import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../client';
import { images, knnEdges } from '../schema';

// k-nearest-neighbor graph query helpers. The graph is built by the
// knn.rebuild job (src/lib/jobs/handlers/knnRebuild.ts) and optionally
// scripts/build-knn.ts. Edges are directed (src -> dst) with a cosine
// distance weight. The build writes both directions (A->B and B->A), so
// pathfinding can treat the graph as undirected by only following srcId edges.

export type KnnNeighbor = { dstId: number; dist: number };

// Which of the given nodes are genuinely adjacent in the kNN graph. Returns a
// Set of "min:max" pair keys (order-normalized) for every image-to-image edge
// found among `nodeIds`, so callers can ask "is this traversal backed by a real
// graph edge?" with a single round-trip and O(1) lookups.
//
// Used by desire.promote to gate promotion on graph-backed traffic: /api/traffic
// accepts client-supplied walks, so without this an unauthenticated caller could
// post arbitrary real image ids and manufacture a public desire path between
// images that were never actually walkable. Every legitimate walk comes from a
// completed /connect journey, which findPath built out of these very edges, so
// requiring kNN backing drops no real traffic.
//
// Keys are order-normalized because the graph is written symmetrically (see
// above); normalizing means a corridor is accepted whenever the pair is
// adjacent, without depending on which direction a given rebuild happened to
// leave behind. It does not weaken the check -- an attacker still cannot invent
// a pair that is not semantically adjacent.
export function knnPairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export async function getKnnPairsAmong(nodeIds: number[]): Promise<Set<string>> {
  const out = new Set<string>();
  const unique = [...new Set(nodeIds)];
  if (unique.length === 0) return out;

  const rows = await db
    .select({ srcId: knnEdges.srcId, dstId: knnEdges.dstId })
    .from(knnEdges)
    .where(
      and(
        inArray(knnEdges.srcId, unique),
        inArray(knnEdges.dstId, unique),
        // 'lore' nodes share the id space with images; a desire path is a
        // corridor of images, so only image-to-image adjacency counts.
        eq(knnEdges.srcType, 'image'),
        eq(knnEdges.dstType, 'image')
      )
    );

  for (const r of rows) out.add(knnPairKey(r.srcId, r.dstId));
  return out;
}

// Load all outgoing edges for a set of node ids in one round-trip. Returns
// a Map keyed by srcId so the pathfinder avoids a separate lookup per node
// when expanding the frontier.
export async function getEdgesForNodes(
  nodeIds: number[]
): Promise<Map<number, KnnNeighbor[]>> {
  const out = new Map<number, KnnNeighbor[]>();
  if (nodeIds.length === 0) return out;

  const rows = await db
    .select({ srcId: knnEdges.srcId, dstId: knnEdges.dstId, dist: knnEdges.dist })
    .from(knnEdges)
    .where(inArray(knnEdges.srcId, nodeIds));

  for (const r of rows) {
    const neighbors = out.get(r.srcId) ?? [];
    neighbors.push({ dstId: r.dstId, dist: r.dist });
    out.set(r.srcId, neighbors);
  }
  return out;
}

// Like getEdgesForNodes but filters out neighbors whose destination image is
// marked NSFW. Used by /api/path and /connect when the visitor has not opted
// in to NSFW content, so Dijkstra never routes through hidden images.
export async function getEdgesForNodesExcludingNsfw(
  nodeIds: number[]
): Promise<Map<number, KnnNeighbor[]>> {
  const out = new Map<number, KnnNeighbor[]>();
  if (nodeIds.length === 0) return out;

  // Join knn_edges to images so we can filter dstId rows where is_nsfw=true
  // in one round-trip rather than loading then filtering in JS.
  const rows = await db
    .select({ srcId: knnEdges.srcId, dstId: knnEdges.dstId, dist: knnEdges.dist })
    .from(knnEdges)
    .innerJoin(images, and(eq(images.id, knnEdges.dstId), eq(images.isNsfw, false)))
    .where(inArray(knnEdges.srcId, nodeIds));

  for (const r of rows) {
    const neighbors = out.get(r.srcId) ?? [];
    neighbors.push({ dstId: r.dstId, dist: r.dist });
    out.set(r.srcId, neighbors);
  }
  return out;
}

// Mirror of getEdgesForNodesExcludingNsfw but restricted to NSFW nodes only.
// Both the source AND destination must be NSFW so SFW start nodes are never
// expanded and never appear in the reconstructed path.
export async function getEdgesForNodesNsfwOnly(
  nodeIds: number[]
): Promise<Map<number, KnnNeighbor[]>> {
  const out = new Map<number, KnnNeighbor[]>();
  if (nodeIds.length === 0) return out;

  // Filter the source frontier to NSFW-only before touching edges, so SFW
  // start/intermediate nodes are silently skipped rather than expanded.
  const nsfwSrcRows = await db
    .select({ id: images.id })
    .from(images)
    .where(and(inArray(images.id, nodeIds), eq(images.isNsfw, true)));
  const nsfwNodeIds = nsfwSrcRows.map((r) => r.id);
  if (nsfwNodeIds.length === 0) return out;

  const rows = await db
    .select({ srcId: knnEdges.srcId, dstId: knnEdges.dstId, dist: knnEdges.dist })
    .from(knnEdges)
    .innerJoin(images, and(eq(images.id, knnEdges.dstId), eq(images.isNsfw, true)))
    .where(inArray(knnEdges.srcId, nsfwNodeIds));

  for (const r of rows) {
    const neighbors = out.get(r.srcId) ?? [];
    neighbors.push({ dstId: r.dstId, dist: r.dist });
    out.set(r.srcId, neighbors);
  }
  return out;
}

// Load all outgoing edges for a single node. Thin wrapper around
// getEdgesForNodes used when the caller has exactly one node.
export async function getEdgesForNode(nodeId: number): Promise<KnnNeighbor[]> {
  const rows = await db
    .select({ dstId: knnEdges.dstId, dist: knnEdges.dist })
    .from(knnEdges)
    .where(eq(knnEdges.srcId, nodeId));
  return rows.map((r) => ({ dstId: r.dstId, dist: r.dist }));
}

// All image<->image edges, as plain {src,dst,dist}. Used by the universe
// community detection (districts) which treats the kNN graph as the world's
// geometry. Scoped to src_type/dst_type='image' so any future lore edges never
// leak into district clustering.
export async function listAllImageEdges(): Promise<
  { src: number; dst: number; dist: number }[]
> {
  const rows = await db
    .select({ src: knnEdges.srcId, dst: knnEdges.dstId, dist: knnEdges.dist })
    .from(knnEdges)
    .where(and(eq(knnEdges.srcType, 'image'), eq(knnEdges.dstType, 'image')));
  return rows.map((r) => ({ src: r.src, dst: r.dst, dist: r.dist }));
}

// Count of edges currently in the graph. Returned by the admin enqueue
// route so the caller can confirm that a rebuild actually produced edges.
export async function countKnnEdges(): Promise<number> {
  const res = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM knn_edges`
  );
  return Number(res.rows?.[0]?.n ?? 0);
}

// Delete all existing edges before a rebuild so the table never accumulates
// stale rows when k changes or images are removed. TRUNCATE RESTART IDENTITY
// is faster than DELETE for a full clear and resets the serial counter so id
// values stay compact.
export async function clearAllKnnEdges(): Promise<void> {
  await db.execute(sql`TRUNCATE TABLE knn_edges RESTART IDENTITY`);
}

// Bulk-insert edges in chunks of 500. Drizzle's multi-row .values(array)
// compiles to a single INSERT ... VALUES (...),(...) statement which is
// much faster than individual inserts over Neon serverless connections.
// The unique (src_id, dst_id) constraint makes this idempotent via upsert.
export async function insertKnnEdges(
  edges: { srcId: number; dstId: number; dist: number }[]
): Promise<void> {
  if (edges.length === 0) return;

  // 500 rows * 3 columns = 1500 parameters, safely under Postgres's 65535 limit.
  const CHUNK = 500;
  for (let i = 0; i < edges.length; i += CHUNK) {
    const chunk = edges.slice(i, i + CHUNK);
    await db
      .insert(knnEdges)
      .values(chunk.map((e) => ({ srcId: e.srcId, dstId: e.dstId, dist: e.dist })))
      .onConflictDoUpdate({
        target: [knnEdges.srcId, knnEdges.dstId],
        set: { dist: sql`EXCLUDED.dist` }
      });
  }
}
