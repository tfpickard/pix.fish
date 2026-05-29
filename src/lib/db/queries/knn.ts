import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../client';
import { images, knnEdges } from '../schema';

// k-nearest-neighbor graph query helpers. The graph is built by the
// knn.rebuild job (src/lib/jobs/handlers/knnRebuild.ts) and optionally
// scripts/build-knn.ts. Edges are directed (src -> dst) with a cosine
// distance weight. The build writes both directions (A->B and B->A), so
// pathfinding can treat the graph as undirected by only following srcId edges.

export type KnnNeighbor = { dstId: number; dist: number };

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

// Load all outgoing edges for a single node. Thin wrapper around
// getEdgesForNodes used when the caller has exactly one node.
export async function getEdgesForNode(nodeId: number): Promise<KnnNeighbor[]> {
  const rows = await db
    .select({ dstId: knnEdges.dstId, dist: knnEdges.dist })
    .from(knnEdges)
    .where(eq(knnEdges.srcId, nodeId));
  return rows.map((r) => ({ dstId: r.dstId, dist: r.dist }));
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
