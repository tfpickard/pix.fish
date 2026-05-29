import { NextResponse } from 'next/server';
import { getRequestIp, hashIp } from '@/lib/hash';
import { rateLimit } from '@/lib/rate-limit';
import { bumpAttention } from '@/lib/db/queries/attention';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/attention -- ingest anonymous, aggregate on-screen dwell.
//
// Privacy posture (non-negotiable, enforced both ends):
//  - The client only sends anything when the visitor has NOT enabled Do Not
//    Track and has NOT opted out (see attention-client.ts). When suppressed,
//    no observers run and this endpoint is never called.
//  - We store NO PII. The body is a list of { imageId, ms } dwell samples. We
//    derive a salted ip-hash purely for rate limiting (same pattern as
//    reactions/comments) and never persist it -- only the per-image
//    accumulated weight in image_attention is written.
//  - The endpoint is best-effort: malformed or out-of-range samples are
//    dropped, and any failure returns ok without surfacing detail.

// Cap a single sample's contribution. Dwell is measured in ms client-side; we
// convert to seconds and clamp so one pinned-open tab can't dominate. A max of
// 30s per sample keeps a long lingering image meaningful but bounded.
const MAX_SAMPLE_MS = 30_000;
// Ignore sub-second flickers (fast scroll-bys) so we measure real dwell.
const MIN_SAMPLE_MS = 1_000;
// Convert dwell ms to a weight increment: 1.0 weight per second on screen.
const MS_PER_WEIGHT = 1_000;
// Bound the batch so a single POST can't enqueue an unbounded write.
const MAX_EVENTS = 100;

interface Sample {
  imageId?: unknown;
  ms?: unknown;
}

export async function POST(req: Request) {
  const ip = getRequestIp(req);
  const ipHash = hashIp(ip);
  // Telemetry is chatty and batched; allow a generous-but-bounded rate.
  if (!rateLimit(`attn:${ipHash}`, 60, 60_000)) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 });
  }

  let body: { events?: Sample[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  const events = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS) : [];

  // Aggregate per imageId in case the client batched multiple samples for the
  // same tile, then convert clamped dwell to a weight increment. Image ids are
  // numeric in this codebase; coerce and validate before trusting them.
  const byImage = new Map<number, number>();
  for (const e of events) {
    const id = typeof e.imageId === 'number' ? e.imageId : Number(e.imageId);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (typeof e.ms !== 'number' || !Number.isFinite(e.ms)) continue;
    if (e.ms < MIN_SAMPLE_MS) continue;
    const clamped = Math.min(e.ms, MAX_SAMPLE_MS);
    byImage.set(id, (byImage.get(id) || 0) + clamped);
  }

  if (byImage.size === 0) return NextResponse.json({ ok: true });

  const increments = Array.from(byImage, ([imageId, ms]) => ({
    imageId,
    increment: ms / MS_PER_WEIGHT
  }));

  try {
    await bumpAttention(increments);
  } catch {
    // Best-effort: never fail the visitor's request over telemetry.
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}
