import { beforeEach, describe, expect, test } from 'bun:test';
import { __resetEdgeRateLimit, edgeRateLimit } from '../src/lib/edge-rate-limit';

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
});
