// Simple in-memory sliding-window rate limiter. Keyed by an arbitrary string
// (typically ip_hash + action). Works for a single-instance deployment; if you
// need multi-instance limiting, swap the Map for an Upstash Ratelimit call.
//
// Note: this Map lives in the module scope and is shared across requests on
// the same function instance. Vercel Fluid Compute reuses instances across
// concurrent requests, so this provides meaningful limiting in practice.

const windows = new Map<string, number[]>();

export function rateLimit(key: string, maxHits: number, windowMs: number): boolean {
  const now = Date.now();
  const hits = (windows.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= maxHits) return false;
  hits.push(now);
  windows.set(key, hits);
  return true;
}
