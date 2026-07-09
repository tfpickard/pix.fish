import { NextResponse } from 'next/server';
import { getRequestIp, hashIp } from '@/lib/hash';
import { rateLimit } from '@/lib/rate-limit';
import { bumpPathTraffic, type TrafficEdge } from '@/lib/db/queries/path-traffic';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/traffic -- ingest anonymous, aggregate image->image traversals.
//
// The edge sibling of /api/attention. Where attention records dwell ON an image,
// this records that a visitor WALKED from one image to the next (via /connect,
// /drift, /daily), which is otherwise discarded. Read later by desire-paths.
//
// Privacy posture (identical to /api/attention, non-negotiable):
//  - The client only sends anything when the visitor has NOT enabled Do Not
//    Track and has NOT opted out (same consent gate, see traffic-client.ts).
//  - We store NO PII. The body is a walk (ordered image ids) and/or explicit
//    edges. We derive a salted ip-hash purely for rate limiting and never
//    persist it -- only aggregate per-edge weights land in path_traffic.
//  - Best-effort on the DATA: unparseable/degenerate edges are dropped and any
//    write failure returns { ok: true } (telemetry never fails the visitor's
//    request). Request-level guards still apply: a rate-limited caller gets 429
//    and an unparseable JSON body gets 400.

// A single traversal contributes this fixed weight to each edge it crosses.
// Traversal is the signal here; dwell is image_attention's job, so we do NOT
// weight by time -- one walk == one unit of wear per edge.
const EDGE_WEIGHT = 1.0;
// Bound one request so a single POST can't enqueue an unbounded write. Applies
// to the walk length and to the explicit-edge list independently.
const MAX_NODES = 256;
const MAX_EDGES = 256;

function toPositiveInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

interface Body {
  // Ordered image ids of a completed traversal. Consecutive ids form directed
  // edges (walk[i] -> walk[i+1]).
  walk?: unknown;
  // Explicit directed edges, as an alternative/supplement to `walk`.
  edges?: unknown;
}

export async function POST(req: Request) {
  const ip = getRequestIp(req);
  const ipHash = hashIp(ip);
  if (!rateLimit(`traffic:${ipHash}`, 60, 60_000)) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 });
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  const edges: TrafficEdge[] = [];

  // Ordered walk -> consecutive directed edges.
  if (Array.isArray(body.walk)) {
    const walk = body.walk.slice(0, MAX_NODES).map(toPositiveInt);
    for (let i = 0; i + 1 < walk.length; i++) {
      const a = walk[i];
      const b = walk[i + 1];
      if (a === null || b === null || a === b) continue;
      edges.push({ srcId: a, dstId: b, weight: EDGE_WEIGHT });
    }
  }

  // Explicit edges { a, b }.
  if (Array.isArray(body.edges)) {
    for (const raw of body.edges.slice(0, MAX_EDGES)) {
      if (!raw || typeof raw !== 'object') continue;
      const a = toPositiveInt((raw as { a?: unknown }).a);
      const b = toPositiveInt((raw as { b?: unknown }).b);
      if (a === null || b === null || a === b) continue;
      edges.push({ srcId: a, dstId: b, weight: EDGE_WEIGHT });
    }
  }

  if (edges.length === 0) return NextResponse.json({ ok: true });

  try {
    await bumpPathTraffic(edges);
  } catch {
    // Best-effort: never fail the visitor's request over telemetry.
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}
