// Desire-path assembly: greedily chain high-traffic adjacent edges into ordered
// corridors. Pure and deterministic (no DB, no clock) so it is trivially
// testable and reproducible: the same edges + options always yield the same
// routes. The desire.promote job feeds it the decayed per-edge traffic from
// path_traffic (getTopPaths) and files the resulting chains.
//
// Why chains, not (a,b) endpoint pairs: Substrate 1 records traffic per edge,
// and /connect can return slightly different node sequences between two images.
// Assembling from edges is robust to that -- a corridor is a run of edges that
// are each worn, regardless of which whole journeys produced them.

export type AssemblyEdge = {
  srcId: number;
  dstId: number;
  value: number; // decayed traffic weight
  lifetime: number; // monotonic traversal count
  // Wall-clock of this edge's last real traversal. Optional so the pure tests
  // (and any caller that doesn't care) can omit it.
  lastUpdatedAt?: Date;
};

export type AssembledRoute = {
  nodeIds: number[]; // ordered image ids, head -> tail
  strength: number; // min edge value along the chain (weakest link)
  lifetime: number; // min edge lifetime along the chain
  // MOST RECENT traversal across the chain's edges (max, not min): the corridor
  // was "walked" whenever any part of it was. Null when no edge carried a
  // timestamp. Strength/lifetime stay weakest-link -- a chain is only as worn
  // as its thinnest segment -- but recency is a max by the same logic.
  lastWalkedAt: Date | null;
};

export type AssembleOptions = {
  // An edge must carry at least this decayed value to be eligible for a chain.
  minEdgeValue?: number;
  // Chains shorter than this many nodes are not corridors; dropped.
  minNodes?: number;
  // Cap chain length so one dominant region can't swallow the whole graph.
  maxNodes?: number;
};

const DEFAULTS = { minEdgeValue: 0, minNodes: 3, maxNodes: 12 };

function edgeKey(src: number, dst: number): string {
  return `${src}:${dst}`;
}

// Deterministic desc-by-value ordering with explicit tie-breaks so assembly is
// stable across runs regardless of the input array's order.
function byValueDesc(a: AssemblyEdge, b: AssemblyEdge): number {
  return b.value - a.value || a.srcId - b.srcId || a.dstId - b.dstId;
}

export function assembleRoutes(
  edges: AssemblyEdge[],
  opts: AssembleOptions = {}
): AssembledRoute[] {
  const minEdgeValue = opts.minEdgeValue ?? DEFAULTS.minEdgeValue;
  const minNodes = opts.minNodes ?? DEFAULTS.minNodes;
  const maxNodes = opts.maxNodes ?? DEFAULTS.maxNodes;

  // Eligible directed edges, de-duped by (src,dst) keeping the strongest, and
  // with self-loops dropped defensively.
  const byPair = new Map<string, AssemblyEdge>();
  for (const e of edges) {
    if (e.srcId === e.dstId) continue;
    // "at least the floor": an edge exactly equal to minEdgeValue is eligible,
    // so a corridor can form at the configured floor rather than just above it.
    if (!(e.value >= minEdgeValue)) continue;
    const k = edgeKey(e.srcId, e.dstId);
    const prev = byPair.get(k);
    if (!prev || e.value > prev.value) byPair.set(k, e);
  }
  const eligible = [...byPair.values()].sort(byValueDesc);
  if (eligible.length === 0) return [];

  // Adjacency for extension lookups.
  const outAdj = new Map<number, AssemblyEdge[]>();
  const inAdj = new Map<number, AssemblyEdge[]>();
  for (const e of eligible) {
    (outAdj.get(e.srcId) ?? outAdj.set(e.srcId, []).get(e.srcId)!).push(e);
    (inAdj.get(e.dstId) ?? inAdj.set(e.dstId, []).get(e.dstId)!).push(e);
  }
  for (const list of outAdj.values()) list.sort(byValueDesc);
  for (const list of inAdj.values()) list.sort(byValueDesc);

  const used = new Set<string>();
  const routes: AssembledRoute[] = [];

  const pickNext = (candidates: AssemblyEdge[] | undefined, inRoute: Set<number>, side: 'out' | 'in') => {
    if (!candidates) return null;
    for (const e of candidates) {
      const k = edgeKey(e.srcId, e.dstId);
      if (used.has(k)) continue;
      const nextNode = side === 'out' ? e.dstId : e.srcId;
      if (inRoute.has(nextNode)) continue; // no cycles / repeats
      return e;
    }
    return null;
  };

  for (const seed of eligible) {
    const seedKey = edgeKey(seed.srcId, seed.dstId);
    if (used.has(seedKey)) continue;

    const nodes = [seed.srcId, seed.dstId];
    const inRoute = new Set(nodes);
    used.add(seedKey);
    let minVal = seed.value;
    let minLife = seed.lifetime;
    let lastWalked = seed.lastUpdatedAt ?? null;
    // Recency is a max across the chain (see AssembledRoute): the corridor
    // counts as walked whenever any of its segments was.
    const noteWalk = (at: Date | undefined) => {
      if (at && (!lastWalked || at > lastWalked)) lastWalked = at;
    };

    // Extend forward from the tail.
    while (nodes.length < maxNodes) {
      const tail = nodes[nodes.length - 1]!;
      const e = pickNext(outAdj.get(tail), inRoute, 'out');
      if (!e) break;
      used.add(edgeKey(e.srcId, e.dstId));
      nodes.push(e.dstId);
      inRoute.add(e.dstId);
      minVal = Math.min(minVal, e.value);
      minLife = Math.min(minLife, e.lifetime);
      noteWalk(e.lastUpdatedAt);
    }

    // Extend backward from the head.
    while (nodes.length < maxNodes) {
      const head = nodes[0]!;
      const e = pickNext(inAdj.get(head), inRoute, 'in');
      if (!e) break;
      used.add(edgeKey(e.srcId, e.dstId));
      nodes.unshift(e.srcId);
      inRoute.add(e.srcId);
      minVal = Math.min(minVal, e.value);
      minLife = Math.min(minLife, e.lifetime);
      noteWalk(e.lastUpdatedAt);
    }

    if (nodes.length >= minNodes) {
      routes.push({
        nodeIds: nodes,
        strength: minVal,
        lifetime: minLife,
        lastWalkedAt: lastWalked
      });
    }
  }

  // Strongest corridors first.
  routes.sort((a, b) => b.strength - a.strength || b.lifetime - a.lifetime);
  return routes;
}

// Canonical identity of a route's node sequence, used as the upsert key so
// re-promoting the same corridor updates rather than duplicates.
export function routeSignature(nodeIds: number[]): string {
  return nodeIds.join('-');
}
