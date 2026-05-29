'use client';

// Client-side attention telemetry: consent gate + batched sender.
//
// Privacy posture (must hold before ANY measurement happens):
//  - Do Not Track: if the browser signals DNT, we collect nothing. No
//    observers are attached and nothing is sent. This is checked first.
//  - Explicit opt-out: a persistent localStorage flag the visitor controls via
//    a visible toggle (see AttentionToggle). When set, collection is off.
//  - Default: collection is ON only when DNT is unset AND the user has not
//    opted out. We store NO PII anywhere -- only per-image dwell durations are
//    sent, and the server keeps only aggregate per-image counts.
//
// This module is the single source of truth for "are we allowed to collect?"
// (isCollectionEnabled). The grid must consult it before observing.

export const ATTENTION_OPTOUT_KEY = 'pix_attention_optout';

// True if the browser's Do Not Track signal is on (any of the legacy spots).
export function isDoNotTrack(): boolean {
  if (typeof navigator === 'undefined') return false;
  const dnt =
    navigator.doNotTrack ||
    (typeof window !== 'undefined'
      ? (window as unknown as { doNotTrack?: string }).doNotTrack
      : undefined) ||
    (navigator as unknown as { msDoNotTrack?: string }).msDoNotTrack;
  return dnt === '1' || dnt === 'yes';
}

// True if the visitor has explicitly opted out via the toggle.
export function isOptedOut(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(ATTENTION_OPTOUT_KEY) === '1';
  } catch {
    // If storage is unavailable we cannot honour a future opt-out, so fail
    // closed: treat as opted out and collect nothing.
    return true;
  }
}

// Persist the opt-out preference.
export function setOptedOut(value: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (value) localStorage.setItem(ATTENTION_OPTOUT_KEY, '1');
    else localStorage.removeItem(ATTENTION_OPTOUT_KEY);
  } catch {
    // Best-effort; nothing else to do if storage is blocked.
  }
}

// The single gate: collection runs only if NOT DNT and NOT opted out.
export function isCollectionEnabled(): boolean {
  return !isDoNotTrack() && !isOptedOut();
}

export interface DwellEvent {
  imageId: number;
  ms: number;
}

// Send a batch of dwell events to /api/attention. Fire-and-forget; uses
// sendBeacon when available (survives page unload) and falls back to fetch with
// keepalive. Re-checks the consent gate at send time so a mid-session opt-out
// immediately stops transmission.
export function sendAttentionBatch(events: DwellEvent[]): void {
  if (events.length === 0) return;
  if (!isCollectionEnabled()) return;

  const payload = JSON.stringify({ events });
  try {
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon('/api/attention', blob);
      return;
    }
  } catch {
    // fall through to fetch
  }
  try {
    void fetch('/api/attention', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true
    });
  } catch {
    // Telemetry is best-effort; swallow.
  }
}
