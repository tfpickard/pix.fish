'use client';

// Client-side traffic telemetry: emits the image->image walks a visitor
// actually completes (e.g. a /connect journey) to /api/traffic, where they
// accumulate in path_traffic for the desire-paths feature.
//
// Consent: this reuses the SINGLE attention consent gate (isCollectionEnabled),
// so Do Not Track and the visitor's explicit opt-out suppress traffic exactly
// as they suppress dwell. There is no separate opt-out to reason about.

import { isCollectionEnabled } from './attention-client';

// Per-session de-dupe so a back/refresh on the same rendered walk does not
// double-count it. Keyed by the walk itself; scoped to the tab (sessionStorage)
// so a genuinely new session re-counts, which is the intended behaviour.
const SENT_PREFIX = 'pix_traffic_sent:';

function alreadySent(key: string): boolean {
  if (typeof sessionStorage === 'undefined') return false;
  try {
    return sessionStorage.getItem(SENT_PREFIX + key) === '1';
  } catch {
    return false;
  }
}

function markSent(key: string): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(SENT_PREFIX + key, '1');
  } catch {
    // best-effort
  }
}

// Fire-and-forget a completed walk (ordered image ids). Consecutive ids become
// directed edges server-side. `dedupeKey` (default: the walk itself) guards
// against re-sending the same journey within the tab session.
export function sendTrafficWalk(imageIds: number[], dedupeKey?: string): void {
  const walk = imageIds.filter((n) => Number.isInteger(n) && n > 0);
  if (walk.length < 2) return;
  if (!isCollectionEnabled()) return;

  const key = dedupeKey ?? walk.join('-');
  if (alreadySent(key)) return;
  markSent(key);

  const payload = JSON.stringify({ walk });
  try {
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon('/api/traffic', blob);
      return;
    }
  } catch {
    // fall through to fetch
  }
  try {
    void fetch('/api/traffic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true
    });
  } catch {
    // Telemetry is best-effort; swallow.
  }
}
