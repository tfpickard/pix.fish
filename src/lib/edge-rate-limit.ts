// Edge-runtime rate limiter for `middleware.ts`.
//
// Distinct from `./rate-limit.ts` on purpose. That one is a sliding window
// keyed per action, called a handful of times per request inside Node route
// handlers, and it keeps an array of hit timestamps per key. This one runs on
// *every* request that reaches the edge, including a flood, so the per-hit
// array push/filter is the wrong shape: it allocates on the hot path and the
// arrays grow with the limit. A fixed-window counter is two numbers per key.
//
// The tradeoff of a fixed window is boundary burst: a client can spend its
// whole allowance at the end of one window and again at the start of the next,
// so the true worst case is 2x the configured limit over a window-length span.
// That is fine here -- the goal is to cap a runaway client's cost, not to meter
// billing.
//
// Scope caveat: the counters live in the module scope of one edge instance.
// Vercel runs middleware in many instances across many regions, so a client
// spread over regions gets roughly (limit x instances it lands on). This is a
// meaningful backstop against a single hammering client and is NOT a substitute
// for a Vercel WAF rate-limit rule, which counts globally and rejects before
// any of our code is invoked. See docs/rate-limiting.md.

type Window = {
  count: number;
  // Epoch ms at which `count` resets. Doubles as the entry's liveness marker.
  resetAt: number;
};

const windows = new Map<string, Window>();

// Bounds memory when a flood arrives from many unique IPs before the instance
// recycles. Map preserves insertion order, so deleting from the front evicts
// the oldest-inserted key.
const MAX_KEYS = 20_000;
// Evicting one key per insert cannot keep up with a burst of new keys, so
// oversized maps shed a batch at once.
const EVICT_BATCH = 2_000;

export type EdgeRateLimitResult = {
  ok: boolean;
  limit: number;
  remaining: number;
  // Seconds until the current window resets. Sent as `Retry-After`.
  retryAfter: number;
};

export function edgeRateLimit(
  key: string,
  maxHits: number,
  windowMs: number,
  now: number = Date.now()
): EdgeRateLimitResult {
  const existing = windows.get(key);

  if (!existing || existing.resetAt <= now) {
    // Re-set rather than mutate so the key moves to the back of the insertion
    // order, keeping the eviction sweep biased toward genuinely idle keys.
    windows.delete(key);
    windows.set(key, { count: 1, resetAt: now + windowMs });
    if (windows.size > MAX_KEYS) evict(now);
    return { ok: true, limit: maxHits, remaining: maxHits - 1, retryAfter: 0 };
  }

  const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));

  // Move the key to the back of the insertion order on every access, so the
  // eviction sweep below reads as least-recently-*used* rather than
  // least-recently-*started*. Without this, ordering reflects only when each
  // window opened, and a flood of unique keys evicts whichever active windows
  // began earliest -- exactly the heavy hitters. An evicted key is recreated
  // on its next request with a fresh count, so that ordering would let a
  // sustained flooder reset itself indefinitely. Two hash lookups on the hot
  // path is the right price; the window object itself is reused, so this
  // allocates nothing.
  windows.delete(key);
  windows.set(key, existing);

  if (existing.count >= maxHits) {
    // Deliberately not incrementing past the limit: a sustained flood would
    // otherwise overflow the counter and the number carries no information
    // once the gate is closed.
    return { ok: false, limit: maxHits, remaining: 0, retryAfter };
  }

  existing.count += 1;
  return { ok: true, limit: maxHits, remaining: maxHits - existing.count, retryAfter };
}

function evict(now: number): void {
  // First pass: drop anything already expired -- free, and usually enough.
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
  if (windows.size <= MAX_KEYS) return;
  // Still over: shed the oldest-inserted batch. These are the least recently
  // *started* windows, which for a fixed window is the closest cheap proxy for
  // least recently active.
  let dropped = 0;
  for (const key of windows.keys()) {
    windows.delete(key);
    if (++dropped >= EVICT_BATCH) break;
  }
}

// Test seam. Module-scope state would otherwise leak between test cases.
export function __resetEdgeRateLimit(): void {
  windows.clear();
}
