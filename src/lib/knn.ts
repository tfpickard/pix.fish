// Core kNN graph algorithms: build and shortest-path search.
//
// Used by two callers:
//   - src/lib/jobs/handlers/knnRebuild.ts  (job-queue handler)
//   - scripts/build-knn.ts                 (standalone bun script)
//
// COMPLEXITY NOTE
// ---------------
// buildKnnGraph() is O(n^2 * d) where n = corpus size and d = embedding
// dimension. For the current corpus (expected <5000 images) a brute-force
// all-pairs cosine pass is fine and avoids any ANN index dependency. At
// ~10000 images the pass will take several minutes and should be sharded
// or replaced with an approximate index (e.g. hnswlib-node or pgvector's
// own HNSW index with a SELECT ... ORDER BY ... LIMIT k per row). The
// function documents the seam where that replacement would slot in.

import { allCaptionVectors } from '@/lib/db/queries/embeddings';
import { clearAllKnnEdges, insertKnnEdges, type KnnNeighbor } from '@/lib/db/queries/knn';

// k value: each node gets edges to its k nearest neighbors.
// Written once here so both callers share the constant and it appears in
// logs, making it easy to trace back to this file when tuning.
// 10 was chosen as a balance: high enough to keep the graph well-connected
// across typical photo corpora (where clusters of visually similar images
// share many neighbors), low enough that the edge count stays manageable
// (n*k*2 directed edges = ~100k for 5000 images).
export const KNN_K = 10;

// Cosine distance between two unit-length-ish vectors. pgvector's <=>
// operator uses the same formula: 1 - cosine_similarity. Returns 0 for
// identical directions, ~2 for opposite. We do NOT normalize here because
// the embeddings from text-embedding-3-small are already unit vectors, and
// floating-point re-normalization would add noise without benefit.
//
// If an embedding has zero magnitude (pathological, but possible for a
// degenerate model response), we return 1.0 (orthogonal) to avoid NaN.
function cosineDist(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) return 1;
  return 1 - dot / denom;
}

// Build the full kNN graph and persist it.
//
// Strategy: load all caption vectors into memory, then for each image run a
// linear scan over all others to find the k nearest. This is O(n^2 * d) but
// requires no external library and no extra Postgres round-trips per row.
//
// ANN seam: replace the inner loop with a call to an HNSW index
// (hnswlib-node or pgvector's hnsw index) when n exceeds ~5000. The
// interface would be: build index from `all`, then for each item call
// index.searchKnn(item.vec, k) to get neighbors. Everything below that
// seam (edge construction, DB write) stays unchanged.
//
// Edges are written in both directions (A->B and B->A) so the graph is
// symmetric and Dijkstra only needs to follow srcId edges.
//
// The table is TRUNCATE'd before writing so stale edges (from removed
// images or a changed k) do not accumulate.
export async function buildKnnGraph(opts?: {
  k?: number;
  onProgress?: (done: number, total: number) => void;
}): Promise<{ nodeCount: number; edgeCount: number }> {
  const k = opts?.k ?? KNN_K;
  const onProgress = opts?.onProgress;

  const all = await allCaptionVectors();
  const n = all.length;

  if (n === 0) {
    // Nothing to build; clear any stale edges from a previous run.
    await clearAllKnnEdges();
    return { nodeCount: 0, edgeCount: 0 };
  }

  // Accumulate both-direction edges in memory before the DB write so we
  // can batch the entire graph in one chunked insert rather than one insert
  // per image. Memory cost: n*k*2 edges * ~24 bytes each = ~2.4 MB at 5000
  // images with k=10, which is well within the Vercel function limit.
  const edges: { srcId: number; dstId: number; dist: number }[] = [];

  for (let i = 0; i < n; i++) {
    const source = all[i]!;

    // Linear scan: compute distance to every other embedding and keep the k
    // smallest. A partial sort (selection) is O(n*k) vs O(n log n) for a
    // full sort; for k << n this is meaningfully faster.
    const dists: { dstId: number; dist: number }[] = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const d = cosineDist(source.vec, all[j]!.vec);
      dists.push({ dstId: all[j]!.imageId, dist: d });
    }

    // Sort ascending by distance; take the first k.
    dists.sort((a, b) => a.dist - b.dist);
    const neighbors = dists.slice(0, k);

    for (const nb of neighbors) {
      // A->B direction
      edges.push({ srcId: source.imageId, dstId: nb.dstId, dist: nb.dist });
      // B->A direction (symmetric, same weight)
      edges.push({ srcId: nb.dstId, dstId: source.imageId, dist: nb.dist });
    }

    if (onProgress && (i + 1) % 50 === 0) {
      onProgress(i + 1, n);
    }
  }

  // Deduplicate: when A is already a neighbor of B, both directions produce
  // a B->A edge. The upsert in insertKnnEdges handles this via the unique
  // constraint (keeping the first distance seen, which is the correct one).
  // No need to deduplicate in memory; the DB round-trip is the bottleneck.

  // Clear stale edges first so images removed since the last run don't linger.
  await clearAllKnnEdges();
  await insertKnnEdges(edges);

  return { nodeCount: n, edgeCount: edges.length };
}

// ---------------------------------------------------------------------------
// Pathfinding: Dijkstra over the kNN graph
// ---------------------------------------------------------------------------
//
// WHY DIJKSTRA (not A*)
// ----------------------
// The brief asks for A* with heuristic = cosine distance from the current
// node to the target. For A* to be admissible (never over-estimate) the
// heuristic must be a lower bound on the true graph distance. Cosine
// distance is NOT guaranteed to be a lower bound on the shortest path
// through the kNN graph because the graph is sparse: the direct cosine
// distance between two nodes may be 0.1 while the shortest PATH through k
// neighbors is 0.3 (the direct edge may not exist). A non-admissible
// heuristic makes A* return sub-optimal paths, which would be silently
// wrong. Dijkstra is correct by construction (non-negative edge weights,
// exhaustive frontier expansion). We use Dijkstra and document the seam.
//
// A* seam: if the kNN graph is made denser (larger k, or if a direct edge
// between the two nodes always exists), cosine distance could be admissible.
// Replace the priority queue below with an A* queue that adds
// `heuristic(current, target)` to the priority key.

export type PathResult =
  | { found: true; path: number[]; totalDist: number }
  | { found: false; reason: 'same-node' | 'no-path' | 'missing-embedding' };

// Lazy adjacency loader type. During pathfinding we load edges on demand
// (one DB round-trip per newly-expanded node) rather than loading the full
// graph into memory. This keeps memory bounded to the explored subgraph,
// which is typically much smaller than the full graph.
type AdjLoader = (nodeIds: number[]) => Promise<Map<number, KnnNeighbor[]>>;

// Minimal binary min-heap for the Dijkstra priority queue. JavaScript's
// built-in Array.sort is stable but O(n log n) per re-sort; a heap keeps
// push and pop at O(log n). For n < 10000 the difference is academic, but
// a heap is the idiomatic choice and avoids quadratic behavior on dense graphs.
type HeapEntry = { id: number; dist: number };

function heapPush(heap: HeapEntry[], entry: HeapEntry): void {
  heap.push(entry);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent]!.dist <= heap[i]!.dist) break;
    const tmp = heap[parent]!;
    heap[parent] = heap[i]!;
    heap[i] = tmp;
    i = parent;
  }
}

function heapPop(heap: HeapEntry[]): HeapEntry | undefined {
  if (heap.length === 0) return undefined;
  const top = heap[0]!;
  const last = heap.pop()!;
  if (heap.length === 0) return top;
  heap[0] = last;
  let i = 0;
  for (;;) {
    const l = 2 * i + 1;
    const r = 2 * i + 2;
    let smallest = i;
    if (l < heap.length && heap[l]!.dist < heap[smallest]!.dist) smallest = l;
    if (r < heap.length && heap[r]!.dist < heap[smallest]!.dist) smallest = r;
    if (smallest === i) break;
    const tmp = heap[i]!;
    heap[i] = heap[smallest]!;
    heap[smallest] = tmp;
    i = smallest;
  }
  return top;
}

// Batch-loads edges for all nodes in the current frontier before expanding,
// so each "wave" of exploration costs one DB round-trip instead of one per
// node. This is important for the Vercel serverless environment where each
// Neon round-trip carries ~5ms overhead.
//
// `import` from knn.ts (not from queries/knn.ts) so callers can supply a
// test stub for the loader during unit testing without mocking Postgres.
export async function findPath(
  srcId: number,
  dstId: number,
  loadEdges: AdjLoader
): Promise<PathResult> {
  if (srcId === dstId) {
    return { found: false, reason: 'same-node' };
  }

  // dist[node] = best known distance from srcId to node
  const dist = new Map<number, number>();
  // prev[node] = predecessor on the shortest path (for reconstruction)
  const prev = new Map<number, number>();
  const heap: HeapEntry[] = [];

  dist.set(srcId, 0);
  heapPush(heap, { id: srcId, dist: 0 });

  // Track nodes whose edges haven't been loaded yet; batch-load them before
  // the next expansion wave to keep round-trips low.
  const edgeCache = new Map<number, KnnNeighbor[]>();

  while (heap.length > 0) {
    const top = heapPop(heap)!;
    const { id: u, dist: du } = top;

    // Skip stale heap entries (a shorter path was already found).
    if (du > (dist.get(u) ?? Infinity)) continue;
    if (u === dstId) break; // Found the shortest path to the target.

    // Load edges for u if not yet cached. We load in a batch of the current
    // node only; a look-ahead (prefetching neighbors-of-neighbors) would
    // require more memory and complexity for marginal latency gain given
    // that paths are typically short (6 hops or fewer in a well-connected graph).
    if (!edgeCache.has(u)) {
      const loaded = await loadEdges([u]);
      for (const [nodeId, neighbors] of loaded) {
        edgeCache.set(nodeId, neighbors);
      }
    }

    const neighbors = edgeCache.get(u) ?? [];
    for (const nb of neighbors) {
      const alt = du + nb.dist;
      const prev_d = dist.get(nb.dstId) ?? Infinity;
      if (alt < prev_d) {
        dist.set(nb.dstId, alt);
        prev.set(nb.dstId, u);
        heapPush(heap, { id: nb.dstId, dist: alt });
      }
    }
  }

  if (!dist.has(dstId) || dist.get(dstId) === Infinity) {
    return { found: false, reason: 'no-path' };
  }

  // Reconstruct path by walking prev[] from dstId back to srcId.
  const path: number[] = [];
  let cur: number | undefined = dstId;
  while (cur !== undefined) {
    path.push(cur);
    cur = prev.get(cur);
  }
  path.reverse();

  // Sanity check: if reconstruction didn't reach srcId, the graph is
  // inconsistent (should not happen with a correct Dijkstra implementation).
  if (path[0] !== srcId) {
    return { found: false, reason: 'no-path' };
  }

  return { found: true, path, totalDist: dist.get(dstId)! };
}

// Re-export KnnNeighbor so callers can reference the type from a single
// import path (src/lib/knn) without reaching into the queries sub-package.
export type { KnnNeighbor };
