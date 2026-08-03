import { beforeEach, describe, expect, test } from 'bun:test';
import { __resetEdgeRateLimit, edgeRateLimit, parseRpm } from '../src/lib/edge-rate-limit';

// `now` is injected in every case: the limiter's whole contract is about
// window boundaries, and asserting them with real time would make the suite
// both slow and flaky.
const WINDOW = 60_000;

describe('edgeRateLimit', () => {
  beforeEach(() => {
    __resetEdgeRateLimit();
  });

  test('allows up to the limit and then closes the gate', () => {
    for (let i = 0; i < 5; i++) {
      const verdict = edgeRateLimit('ip', 5, WINDOW, 1_000);
      expect(verdict.ok).toBe(true);
      expect(verdict.remaining).toBe(4 - i);
    }
    const blocked = edgeRateLimit('ip', 5, WINDOW, 1_000);
    expect(blocked.ok).toBe(false);
    expect(blocked.remaining).toBe(0);
  });

  test('stays closed for the rest of the window and reopens after it', () => {
    for (let i = 0; i < 3; i++) edgeRateLimit('ip', 3, WINDOW, 1_000);

    expect(edgeRateLimit('ip', 3, WINDOW, 1_000 + WINDOW - 1).ok).toBe(false);
    expect(edgeRateLimit('ip', 3, WINDOW, 1_000 + WINDOW).ok).toBe(true);
  });

  test('counts each key independently', () => {
    for (let i = 0; i < 3; i++) edgeRateLimit('a', 3, WINDOW, 1_000);
    expect(edgeRateLimit('a', 3, WINDOW, 1_000).ok).toBe(false);
    expect(edgeRateLimit('b', 3, WINDOW, 1_000).ok).toBe(true);
  });

  test('reports retryAfter in whole seconds, never zero while throttled', () => {
    edgeRateLimit('ip', 1, WINDOW, 0);
    expect(edgeRateLimit('ip', 1, WINDOW, 0).retryAfter).toBe(60);
    // 1ms of window left still has to round up -- a Retry-After of 0 would
    // invite an immediate retry that is guaranteed to be throttled again.
    expect(edgeRateLimit('ip', 1, WINDOW, WINDOW - 1).retryAfter).toBe(1);
  });

  test('survives a flood of unique keys without unbounded growth', () => {
    // Well past MAX_KEYS (20k). The assertion that matters is that the limiter
    // still gates correctly afterwards -- eviction must not corrupt live keys.
    for (let i = 0; i < 25_000; i++) edgeRateLimit(`flood-${i}`, 5, WINDOW, 1_000);

    const fresh = edgeRateLimit('post-flood', 2, WINDOW, 1_000);
    expect(fresh.ok).toBe(true);
    edgeRateLimit('post-flood', 2, WINDOW, 1_000);
    expect(edgeRateLimit('post-flood', 2, WINDOW, 1_000).ok).toBe(false);
  });

  test('a key that keeps hammering is not evicted by a unique-key flood', () => {
    // The failure this guards against: eviction ordered by when a window
    // *opened* rather than when it was last *used*. A heavy hitter opens its
    // window early, so it sorts oldest, so a flood of new keys evicts it --
    // and it comes back with a fresh count. That is precisely backwards, and
    // the many-unique-IP flood is the case the limiter exists for.
    const hammer = () => edgeRateLimit('hammer', 10, WINDOW, 1_000);

    // Open the window first, so it is the oldest by window-start ordering.
    for (let i = 0; i < 10; i++) hammer();
    expect(hammer().ok).toBe(false);

    // Count how many times the key comes back as a *fresh* window. Asserting
    // "still throttled at the end" would prove nothing: an evicted key that
    // gets recreated re-accrues its 10 hits within a few hundred iterations
    // and looks throttled again by the time the loop ends. Only the opening
    // of a new window returns retryAfter === 0, so that is the signature of a
    // reset, and after the first window there must never be another.
    let resets = 0;
    for (let i = 0; i < 30_000; i++) {
      edgeRateLimit(`noise-${i}`, 10, WINDOW, 1_000);
      if (i % 5 === 0 && hammer().retryAfter === 0) resets++;
    }

    expect(resets).toBe(0);
    expect(hammer().ok).toBe(false);
  });
});

describe('parseRpm', () => {
  test('takes a sane positive integer', () => {
    expect(parseRpm('50', 200)).toBe(50);
    expect(parseRpm('1', 200)).toBe(1);
  });

  test('falls back on anything that is not a usable limit', () => {
    for (const raw of [undefined, '', 'abc', '0', '-5', 'Infinity', 'NaN']) {
      expect(parseRpm(raw, 200)).toBe(200);
    }
  });

  test('falls back on a positive fraction rather than flooring it to zero', () => {
    // The bug this guards: 0.5 is finite and > 0, so a naive guard accepts it
    // and Math.floor lands on 0 -- which reads as "block everything" but
    // actually admits the window-opening request and refuses the rest, i.e. a
    // silent 1-request-per-minute limit.
    expect(parseRpm('0.5', 200)).toBe(200);
    expect(parseRpm('0.99', 200)).toBe(200);
    // A fraction at or above 1 is still a usable limit once floored.
    expect(parseRpm('1.9', 200)).toBe(1);
  });
});
