import { mulberry32, seedFromString } from '@/lib/sort/reorder';
import type { Adjacency } from '@/lib/db/queries/daily';

// Pure graph logic for the /daily puzzle. No DB, no Date -- the page passes in
// the adjacency and the date string, so these stay deterministic and testable.

// Single-source shortest hop distances from `src` over the (undirected) kNN
// adjacency. Hop count, not cosine weight: "how many images away" is the unit
// the player reasons about, and it makes par an honest integer.
export function bfsDistances(adj: Adjacency, src: number): Map<number, number> {
  const dist = new Map<number, number>([[src, 0]]);
  const queue: number[] = [src];
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++]!;
    const du = dist.get(u)!;
    for (const { dstId } of adj.get(u) ?? []) {
      if (!dist.has(dstId)) {
        dist.set(dstId, du + 1);
        queue.push(dstId);
      }
    }
  }
  return dist;
}

// Shortest path (fewest hops) from src to dst, or null if unreachable.
export function bfsPath(adj: Adjacency, src: number, dst: number): number[] | null {
  if (src === dst) return [src];
  const prev = new Map<number, number>();
  const seen = new Set<number>([src]);
  const queue: number[] = [src];
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++]!;
    for (const { dstId } of adj.get(u) ?? []) {
      if (seen.has(dstId)) continue;
      seen.add(dstId);
      prev.set(dstId, u);
      if (dstId === dst) {
        const path = [dst];
        let cur = dst;
        while (cur !== src) {
          cur = prev.get(cur)!;
          path.push(cur);
        }
        return path.reverse();
      }
      queue.push(dstId);
    }
  }
  return null;
}

// Days since the launch epoch -> a human puzzle number. Pass UTC-midnight ms.
const EPOCH_UTC = Date.UTC(2026, 0, 1);
export function dailyNumber(utcMidnightMs: number): number {
  return Math.floor((utcMidnightMs - EPOCH_UTC) / 86_400_000) + 1;
}

export type DailyPick = { a: number; b: number; par: number; path: number[] };

// Deterministically pick the day's start (A) and target (B): seed a shuffle
// from the date, then scan for a connected pair whose geodesic length lands in
// a fun range. Falls back to the most distant connected pair if none qualifies
// (tiny / sparse graphs). Same date + same graph => same puzzle for everyone.
export function pickDaily(
  nodeIds: number[],
  adj: Adjacency,
  seed: string,
  minPar = 3,
  maxPar = 7
): DailyPick | null {
  if (nodeIds.length < 2) return null;

  const rand = mulberry32(seedFromString(seed));
  const order = nodeIds.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }

  // Try up to a handful of seeded start candidates; first in-range pair wins.
  let fallback: { a: number; b: number; par: number } | null = null;
  const starts = Math.min(order.length, 16);
  for (let ai = 0; ai < starts; ai++) {
    const a = order[ai]!;
    const dist = bfsDistances(adj, a);
    for (const b of order) {
      if (b === a) continue;
      const d = dist.get(b);
      if (d == null) continue; // unreachable
      if (d >= minPar && d <= maxPar) {
        return { a, b, par: d, path: bfsPath(adj, a, b)! };
      }
      if (!fallback || d > fallback.par) fallback = { a, b, par: d };
    }
  }

  if (fallback) {
    const path = bfsPath(adj, fallback.a, fallback.b);
    if (path) return { a: fallback.a, b: fallback.b, par: fallback.par, path };
  }
  return null;
}
