// Districts from geometry: deterministic community detection over the existing
// image kNN graph. We treat the kNN graph as the world's physics rather than
// re-deriving clusters from raw vectors -- the edges already encode caption
// similarity. Pure and side-effect-free so it is trivially reproducible: same
// nodes + edges + options always yield the same districts.
//
// Method: prune each node to its nearest PRUNE_K neighbours (so a dense k=10
// graph does not collapse into one giant community), then run synchronous
// label propagation with a fully deterministic update rule (ascending node
// order, neighbours weighted by 1/dist, ties broken by smallest label).

export type ClusterEdge = { src: number; dst: number; dist: number };

export type Community = { key: string; memberImageIds: number[] };

export type ClusterOptions = {
  // How many nearest neighbours to keep per node before propagating. Lower =
  // more, smaller districts; higher = fewer, larger ones.
  pruneK?: number;
  maxIters?: number;
};

const DEFAULT_PRUNE_K = 4;
const DEFAULT_MAX_ITERS = 50;

export function detectCommunities(
  nodeIds: number[],
  edges: ClusterEdge[],
  opts: ClusterOptions = {}
): Community[] {
  const pruneK = opts.pruneK ?? DEFAULT_PRUNE_K;
  const maxIters = opts.maxIters ?? DEFAULT_MAX_ITERS;

  const nodes = [...nodeIds].sort((a, b) => a - b);
  const present = new Set(nodes);

  // Collapse directed edges to the smallest distance per unordered pair, and
  // drop edges that touch a node not in the node set.
  const pairDist = new Map<string, number>();
  for (const e of edges) {
    if (!present.has(e.src) || !present.has(e.dst) || e.src === e.dst) continue;
    const a = Math.min(e.src, e.dst);
    const b = Math.max(e.src, e.dst);
    const key = `${a},${b}`;
    const prev = pairDist.get(key);
    if (prev === undefined || e.dist < prev) pairDist.set(key, e.dist);
  }

  // Per-node neighbour lists, then prune each to its nearest pruneK.
  const adj = new Map<number, { nbr: number; dist: number }[]>();
  for (const n of nodes) adj.set(n, []);
  for (const [key, dist] of pairDist) {
    const [a, b] = key.split(',').map(Number) as [number, number];
    adj.get(a)!.push({ nbr: b, dist });
    adj.get(b)!.push({ nbr: a, dist });
  }
  const pruned = new Map<number, { nbr: number; dist: number }[]>();
  for (const n of nodes) {
    const list = adj.get(n)!;
    // Sort by distance asc, then neighbour id asc for a stable tie-break.
    list.sort((x, y) => x.dist - y.dist || x.nbr - y.nbr);
    pruned.set(n, list.slice(0, pruneK));
  }

  // Label propagation. Start each node in its own community.
  const label = new Map<number, number>();
  for (const n of nodes) label.set(n, n);

  for (let iter = 0; iter < maxIters; iter++) {
    let changed = false;
    for (const n of nodes) {
      const neighbours = pruned.get(n)!;
      if (neighbours.length === 0) continue;
      // Weight each neighbour's label by 1/(dist + eps) so closer neighbours
      // pull harder. Deterministic tie-break: smallest label wins.
      const weight = new Map<number, number>();
      for (const { nbr, dist } of neighbours) {
        const lab = label.get(nbr)!;
        weight.set(lab, (weight.get(lab) ?? 0) + 1 / (dist + 1e-6));
      }
      let bestLabel = label.get(n)!;
      let bestWeight = -Infinity;
      for (const [lab, w] of [...weight.entries()].sort((a, b) => a[0] - b[0])) {
        if (w > bestWeight) {
          bestWeight = w;
          bestLabel = lab;
        }
      }
      if (bestLabel !== label.get(n)) {
        label.set(n, bestLabel);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Group by final label, then assign stable district keys ordered by each
  // community's smallest member id (so the keys do not depend on label values).
  const byLabel = new Map<number, number[]>();
  for (const n of nodes) {
    const lab = label.get(n)!;
    const members = byLabel.get(lab) ?? [];
    members.push(n);
    byLabel.set(lab, members);
  }
  const communities = [...byLabel.values()].map((members) => members.sort((a, b) => a - b));
  communities.sort((a, b) => a[0]! - b[0]!);

  return communities.map((memberImageIds, i) => ({
    key: `district-${i}`,
    memberImageIds
  }));
}
