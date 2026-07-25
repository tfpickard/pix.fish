// Process-local TTL memo with single-flight coalescing.
//
// Deliberately NOT next/cache's `unstable_cache`: that round-trips values
// through JSON, which turns the `Date` columns on an image row into strings.
// `buildImageLd` calls `img.uploadedAt.toISOString()` (src/lib/seo/jsonld.ts),
// so a JSON-serialized gallery payload would throw on every render. Keeping
// live objects in-process is the only variant that is safe here.
//
// Scope is one function instance, so N warm instances means N refreshes per
// TTL rather than one globally. Under a traffic spike that is still the
// difference between a DB pass per request and a DB pass per instance per
// TTL, which is the entire point. Vercel Fluid Compute reuses instances
// across concurrent requests, so a hot instance absorbs a lot of hits --
// the same assumption src/lib/rate-limit.ts already runs on.

type Entry<T> = { value: Promise<T>; expiresAt: number };

const store = new Map<string, Entry<unknown>>();

// Bounds memory if the key space is wider than expected (a crawler walking
// arbitrary ?sort= / offset combinations). Overflow just means cache misses,
// never extra load beyond what an uncached request would have cost anyway.
const MAX_KEYS = 500;

/**
 * Returns a cached in-flight or settled promise for `key`, invoking `load`
 * only when there is no live entry.
 *
 * The *promise* is cached rather than the resolved value, which gives
 * single-flight coalescing for free: 50 concurrent requests arriving on a
 * cold key all await one `load()` instead of stampeding the database.
 *
 * Callers share the resolved object, so treat the result as read-only.
 */
export function memoTtl<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.expiresAt > now) return hit.value;

  const value = load();
  store.set(key, { value, expiresAt: now + ttlMs });

  // A rejected load must not sit in the map as a poisoned entry for the whole
  // TTL. Drop it so the next caller retries against a (hopefully) recovered
  // database instead of being served the failure. The identity check keeps a
  // late rejection from evicting a newer entry that already replaced this one.
  value.catch(() => {
    const current = store.get(key);
    if (current && current.value === value) store.delete(key);
  });

  if (store.size > MAX_KEYS) {
    // Map preserves insertion order, so the first key is the oldest-inserted.
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }

  return value;
}

/** Test/ops escape hatch -- drops every memoized entry on this instance. */
export function clearMemo(): void {
  store.clear();
}
