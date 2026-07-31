import { mulberry32, seedFromString } from '@/lib/sort/reorder';
import {
  DISPATCH_BASE_UTC_MINUTE,
  DISPATCH_JITTER_TAIL_MIN,
  DISPATCH_JITTER_TYPICAL_MIN,
  DISPATCH_TAIL_PROBABILITY
} from './config';

// Deterministic per-day fire time. Vercel Cron cannot jitter, so the cron fires
// on a fixed grid across a window and this decides whether "now" is past today's
// chosen minute. Because the choice is derived from the UTC date alone, every
// tick on a given day computes the SAME target -- there is no drift and no way
// for two ticks to disagree about whether the day has fired.
//
// The shape: usually within an hour of the base time, occasionally as much as
// four hours off. A dispatch that lands at 18:17:00 every single day reads as a
// machine; this reads as an institution with an erratic afternoon.

export function utcDateKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

// Minutes-from-UTC-midnight at which the dispatch should fire on `dateKey`.
// Pure and total: same date always yields the same minute, always within
// [0, 1439] so a large tail offset cannot push the target into another day
// (where it would either never fire or fire twice).
export function dispatchMinuteForDate(dateKey: string): number {
  const rand = mulberry32(seedFromString(`x.dispatch:${dateKey}`));
  const takesTail = rand() < DISPATCH_TAIL_PROBABILITY;

  let offset: number;
  if (takesTail) {
    // Uniform anywhere in the wide excursion, either side of the base.
    const magnitude =
      DISPATCH_JITTER_TYPICAL_MIN +
      rand() * (DISPATCH_JITTER_TAIL_MIN - DISPATCH_JITTER_TYPICAL_MIN);
    offset = rand() < 0.5 ? -magnitude : magnitude;
  } else {
    // Sum of three uniforms, centred and scaled: a rough bell inside the typical
    // band, so most days cluster near the base rather than spreading flat.
    const bell = (rand() + rand() + rand()) / 3; // ~0.5 mean
    offset = (bell - 0.5) * 2 * DISPATCH_JITTER_TYPICAL_MIN;
  }

  const minute = Math.round(DISPATCH_BASE_UTC_MINUTE + offset);
  // Clamp rather than wrap. Wrapping past midnight would move the dispatch into
  // a different UTC date than the one that claims it, which breaks the one-per-
  // day dedupe key.
  return Math.min(Math.max(minute, 0), 1439);
}

// True when `now` is at or past today's chosen minute. The cron route calls this
// and simply returns without enqueuing when it is false.
export function isDispatchDue(now: Date): boolean {
  const nowMinute = now.getUTCHours() * 60 + now.getUTCMinutes();
  return nowMinute >= dispatchMinuteForDate(utcDateKey(now));
}

// Whether today's caption takes the drift variant (begins seemingly on topic,
// wanders, and reveals two thirds through that it never was). A minority of
// dispatches, chosen from the date so a re-run of the same day is reproducible.
export const DRIFT_PROBABILITY = 0.25;

// This stays a pure seeded predicate: which days WOULD take the drift variant.
// Whether a scheduled dispatch actually honours it is a separate question, gated
// by DRIFT_ENABLED in config.ts and applied at the point the caption is
// assembled -- keeping the two apart means the schedule module has no opinion on
// whether the variant is currently fit to ship.
export function driftForDate(dateKey: string): boolean {
  return mulberry32(seedFromString(`x.dispatch.drift:${dateKey}`))() < DRIFT_PROBABILITY;
}
