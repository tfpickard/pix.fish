import type { ClusterEdge } from './cluster';

// Salience selection for the autonomous evolution loop: given the current state
// of every specimen plus the kNN graph, score which specimens most deserve a
// fresh clerk amendment this tick. Pure and seeded -- same inputs + seed always
// rank the same way, so a tick is reproducible from its log line.
//
// Signals (each normalized to 0..1, then weighted):
//   coverage  -- under-documented specimens (few fragments) pull harder
//   staleness -- the longer since a specimen was last touched, the higher
//   centrality-- a proxy for graph betweenness: kNN degree (well-connected
//                specimens ripple further, so amending them matters more)
//   tension   -- contradiction potential: a specimen with a single clerk's
//                reading is ripe for a second, dissenting voice
//   walk      -- a seeded random geodesic walk over the kNN graph marks a
//                neighbourhood, injecting spatial variety so the loop roams
//                the manifold instead of fixating on the same hot specimens
//
// A small seeded jitter breaks ties so repeated ticks (different seeds) explore
// different specimens rather than always picking the same top-N.

export type SpecimenSalienceInput = {
  imageId: number;
  fragments: number;
  distinctClerks: number;
  lastTouchedMs: number;
};

export type SalienceOptions = {
  count: number;
  seed: number;
  nowMs: number;
  edges: ClusterEdge[];
  // Window over which "staleness" saturates to 1. Default 14 days.
  staleWindowMs?: number;
  weights?: Partial<Record<'coverage' | 'staleness' | 'centrality' | 'tension' | 'walk', number>>;
  // Walk length for the geodesic neighbourhood bonus.
  walkSteps?: number;
};

export type SaliencePick = {
  imageId: number;
  score: number;
  reasons: string[];
};

const DEFAULT_WEIGHTS = {
  coverage: 1.0,
  staleness: 0.8,
  centrality: 0.6,
  tension: 0.9,
  walk: 0.5
};

const DEFAULT_STALE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

// Deterministic PRNG (same generator the manifold handler uses) so a seed
// fully determines the jitter and the walk.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

// Per-specimen tie-break jitter, derived from (seed, imageId) so it does NOT
// depend on the order specimens are iterated. Drawing jitter from the shared
// walk RNG would make the ranking change if the input row order changed (the
// salience SQL has no stable ORDER BY), breaking reproducibility-from-seed.
function jitterFor(seed: number, imageId: number): number {
  const mixed = (Math.imul(seed, 0x9e3779b1) ^ imageId) >>> 0;
  return mulberry32(mixed)() * 0.05;
}

// Build an undirected adjacency map (nearest distance per pair) from the kNN
// edges, restricted to the given node set.
function buildAdjacency(
  nodeIds: Set<number>,
  edges: ClusterEdge[]
): Map<number, number[]> {
  const adj = new Map<number, number[]>();
  for (const id of nodeIds) adj.set(id, []);
  const seen = new Set<string>();
  for (const e of edges) {
    if (!nodeIds.has(e.src) || !nodeIds.has(e.dst) || e.src === e.dst) continue;
    const a = Math.min(e.src, e.dst);
    const b = Math.max(e.src, e.dst);
    const key = `${a},${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }
  // Sort each adjacency list so the seeded walk is stable for a given edge set,
  // regardless of the order edges were loaded (the kNN query has no ORDER BY).
  for (const list of adj.values()) list.sort((x, y) => x - y);
  return adj;
}

export function selectSalientSpecimens(
  specimens: SpecimenSalienceInput[],
  opts: SalienceOptions
): SaliencePick[] {
  const weights = { ...DEFAULT_WEIGHTS, ...(opts.weights ?? {}) };
  const staleWindow = opts.staleWindowMs ?? DEFAULT_STALE_WINDOW_MS;
  const walkSteps = opts.walkSteps ?? 12;
  const rng = mulberry32(opts.seed);

  if (specimens.length === 0) return [];

  const nodeIds = new Set(specimens.map((s) => s.imageId));
  const adj = buildAdjacency(nodeIds, opts.edges);

  // Centrality proxy: normalized kNN degree.
  let maxDegree = 1;
  for (const id of nodeIds) maxDegree = Math.max(maxDegree, adj.get(id)?.length ?? 0);

  // Seeded geodesic walk from a random start node, following random neighbours.
  // The visited set gets a salience bonus, roaming a connected neighbourhood.
  const visited = new Set<number>();
  const ordered = [...nodeIds].sort((a, b) => a - b);
  if (ordered.length > 0) {
    let current = ordered[Math.floor(rng() * ordered.length)]!;
    visited.add(current);
    for (let step = 0; step < walkSteps; step++) {
      const neighbours = adj.get(current) ?? [];
      if (neighbours.length === 0) break;
      current = neighbours[Math.floor(rng() * neighbours.length)]!;
      visited.add(current);
    }
  }

  const picks: SaliencePick[] = specimens.map((s) => {
    const coverage = 1 / (1 + s.fragments);
    const staleness = clamp01((opts.nowMs - s.lastTouchedMs) / staleWindow);
    const centrality = (adj.get(s.imageId)?.length ?? 0) / maxDegree;
    // A single reading is the most ripe for a dissenting voice; the more clerks
    // already weighing in, the less urgent a fresh contradiction.
    const tension = s.distinctClerks <= 0 ? 0.5 : 1 / s.distinctClerks;
    const walk = visited.has(s.imageId) ? 1 : 0;
    const jitter = jitterFor(opts.seed, s.imageId);

    const score =
      weights.coverage * coverage +
      weights.staleness * staleness +
      weights.centrality * centrality +
      weights.tension * tension +
      weights.walk * walk +
      jitter;

    const reasons: string[] = [];
    // coverage >= 0.5 means <= 1 fragment on file (just the intake, no
    // amendments yet) -- the canonical under-documented case.
    if (coverage >= 0.5) reasons.push('under-documented');
    if (staleness > 0.5) reasons.push('stale');
    if (centrality > 0.5) reasons.push('central');
    if (tension >= 1) reasons.push('single-voice');
    if (walk) reasons.push('geodesic-walk');

    return { imageId: s.imageId, score, reasons };
  });

  picks.sort((a, b) => b.score - a.score || a.imageId - b.imageId);
  return picks.slice(0, Math.max(0, Math.trunc(opts.count)));
}
