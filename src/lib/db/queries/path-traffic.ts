import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { NsfwMode } from '@/lib/nsfw';
import { db } from '../client';
import { images, pathTraffic } from '../schema';
import { decayed, ATTENTION_HALF_LIFE_MS } from '../../attention';

// Query helpers for the path_traffic table (Substrate 1): anonymous, decaying
// per-EDGE traversal telemetry. The edge sibling of image_attention. See
// src/lib/attention.ts for the decay math and privacy notes; the two share the
// same half-life so a node and the edges into it age at the same rate.

// Half-life in seconds for the SQL decay expression, derived from the single
// source of truth so read-time and write-time decay can never diverge.
const HALF_LIFE_SECONDS = ATTENTION_HALF_LIFE_MS / 1000;

export type TrafficEdge = { srcId: number; dstId: number; weight: number };

// Stable string key for an edge. Directed: a->b differs from b->a.
export function edgeKey(srcId: number, dstId: number): string {
  return `${srcId}:${dstId}`;
}

// bumpPathTraffic(): atomically accumulate decaying traffic for many edges.
//
// Same lost-update-safe upsert shape as bumpAttention: the decay-then-add
// happens entirely in SQL under one row lock per (src,dst). `value` decays from
// the row's existing last_updated_at then gains the increment; `lifetime` is a
// monotonic traversal count (never decayed). Self-loops (src == dst) and
// non-positive weights are dropped -- an edge is always between two distinct
// images. Duplicate edges within one call are aggregated first so the upsert
// sees each (src,dst) once (an ON CONFLICT statement cannot hit the same row
// twice in a single command).
export async function bumpPathTraffic(edges: TrafficEdge[]): Promise<void> {
  const byEdge = new Map<string, TrafficEdge>();
  for (const e of edges) {
    if (e.srcId === e.dstId) continue;
    if (!(e.weight > 0)) continue;
    const key = edgeKey(e.srcId, e.dstId);
    const prev = byEdge.get(key);
    if (prev) prev.weight += e.weight;
    else byEdge.set(key, { srcId: e.srcId, dstId: e.dstId, weight: e.weight });
  }
  const rows = [...byEdge.values()];
  if (rows.length === 0) return;

  await db
    .insert(pathTraffic)
    .values(rows.map((r) => ({ srcId: r.srcId, dstId: r.dstId, value: r.weight, lifetime: r.weight })))
    .onConflictDoUpdate({
      target: [pathTraffic.srcId, pathTraffic.dstId],
      set: {
        value: sql`${pathTraffic.value} * power(0.5, extract(epoch from (now() - ${pathTraffic.lastUpdatedAt})) / ${HALF_LIFE_SECONDS}) + excluded.value`,
        lifetime: sql`${pathTraffic.lifetime} + excluded.value`,
        lastUpdatedAt: sql`now()`
      }
    });
}

// getDecayedPathTrafficMap(): read decayed traffic for a specific set of edges.
// Returns a Map keyed by edgeKey(src,dst); edges with no row (or fully decayed
// to zero) are absent. Decay is applied here in JS mirroring bumpPathTraffic's
// SQL, so no cron is needed.
export async function getDecayedPathTrafficMap(
  edges: { srcId: number; dstId: number }[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (edges.length === 0) return out;

  // Match exactly the requested (src,dst) pairs via OR-of-ANDs. The set is
  // bounded (a single walk's edges), so this stays a small, index-friendly query.
  const dbRows = await db
    .select({
      srcId: pathTraffic.srcId,
      dstId: pathTraffic.dstId,
      value: pathTraffic.value,
      lastUpdatedAt: pathTraffic.lastUpdatedAt
    })
    .from(pathTraffic)
    .where(or(...edges.map((e) => and(eq(pathTraffic.srcId, e.srcId), eq(pathTraffic.dstId, e.dstId)))));

  const now = Date.now();
  for (const r of dbRows) {
    const d = decayed(r.value, r.lastUpdatedAt.getTime(), now);
    if (d > 0) out.set(edgeKey(r.srcId, r.dstId), d);
  }
  return out;
}

export type WornEdge = { srcId: number; dstId: number; value: number; lifetime: number };

// getTopPaths(): the most-walked edges by CURRENT (decayed) traffic, descending.
// The natural reader for desire-paths promotion. The path_traffic table is
// small (bounded by walked edges over a few-hundred-image corpus), so we scan
// it and rank in JS with the shared decay function rather than approximate the
// decay in SQL. `limit` caps the returned rows, not the scan.
export async function getTopPaths(limit = 100): Promise<WornEdge[]> {
  const dbRows = await db
    .select({
      srcId: pathTraffic.srcId,
      dstId: pathTraffic.dstId,
      value: pathTraffic.value,
      lifetime: pathTraffic.lifetime,
      lastUpdatedAt: pathTraffic.lastUpdatedAt
    })
    .from(pathTraffic);

  const now = Date.now();
  return dbRows
    .map((r) => ({
      srcId: r.srcId,
      dstId: r.dstId,
      value: decayed(r.value, r.lastUpdatedAt.getTime(), now),
      lifetime: r.lifetime
    }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, Math.max(0, limit));
}

export type VisiblePath = {
  srcId: number;
  dstId: number;
  srcSlug: string;
  dstSlug: string;
  value: number;
  lifetime: number;
};

// getTopPathsVisible(): the most-walked edges by CURRENT (decayed) traffic,
// like getTopPaths but joined to BOTH endpoint images so an edge only counts
// when both ends are publicly visible under `nsfwMode` (and neither is archived
// or basement-gated). This is the reader for the public "worn paths" surface;
// getTopPaths stays the raw, ungated reader for the internal desire-paths job.
// Endpoint slugs ride along so callers can render/label the edge without a
// second lookup. Decay + rank happen in JS on the (small) joined set.
export async function getTopPathsVisible(
  limit: number,
  nsfwMode: NsfwMode
): Promise<VisiblePath[]> {
  const cap = Math.max(0, Math.trunc(limit));
  if (cap === 0) return [];

  const src = alias(images, 'src_img');
  const dst = alias(images, 'dst_img');
  // Same visibility gate applied to each endpoint. Built inline per-alias
  // because the two aliases carry distinct table-name types (a shared helper
  // would pin the parameter to one alias's literal type).
  const nsfwEq = (col: typeof src.isNsfw | typeof dst.isNsfw) =>
    nsfwMode === 'only' ? eq(col, true) : nsfwMode === 'hide' ? eq(col, false) : undefined;

  const dbRows = await db
    .select({
      srcId: pathTraffic.srcId,
      dstId: pathTraffic.dstId,
      srcSlug: src.slug,
      dstSlug: dst.slug,
      value: pathTraffic.value,
      lifetime: pathTraffic.lifetime,
      lastUpdatedAt: pathTraffic.lastUpdatedAt
    })
    .from(pathTraffic)
    .innerJoin(src, eq(src.id, pathTraffic.srcId))
    .innerJoin(dst, eq(dst.id, pathTraffic.dstId))
    .where(
      and(
        isNull(src.archivedAt),
        eq(src.basement, false),
        nsfwEq(src.isNsfw),
        isNull(dst.archivedAt),
        eq(dst.basement, false),
        nsfwEq(dst.isNsfw)
      )
    );

  const now = Date.now();
  return dbRows
    .map((r) => ({
      srcId: r.srcId,
      dstId: r.dstId,
      srcSlug: r.srcSlug,
      dstSlug: r.dstSlug,
      value: decayed(r.value, r.lastUpdatedAt.getTime(), now),
      lifetime: r.lifetime
    }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, cap);
}

// Re-export so callers that gate on graph size can avoid an extra import.
export async function countTrafficEdges(): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(pathTraffic);
  return row?.n ?? 0;
}
