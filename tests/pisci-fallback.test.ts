import { describe, expect, test } from 'bun:test';
import { renderTurn, type Fetcher } from '../src/lib/pisci/render';
import { CANNED, GREETING } from '../src/lib/pisci/canned';
import { makeSeedFromInt } from '../src/lib/pisci/seed';
import type { Beat, FsmState } from '../src/lib/pisci/types';

// Hard-fallback guarantee: with the LLM unreachable, a full session still emits
// an on-beat canned line for every state -- no empty bubbles, no crashes.

// The client now carries only an integer seed; the persona (for canned-line
// assertions) is derived from it the same way the widget and server do.
const SEED_INT = 12345;
const seed = makeSeedFromInt(SEED_INT);
const rng = () => 0; // pick the first canned line, deterministically

// A state in a given beat that WOULD use the LLM (so renderTurn attempts a fetch
// and we exercise the fallback path).
function stateAt(beat: Beat): FsmState {
  return { beat, userTurns: 1, llmTurnsUsed: 0, cannedOnly: false, closedCount: 0, ghosted: false };
}

const NON_DORMANT: Beat[] = ['HOOKED', 'OVERSHARE', 'DEPENDENCY', 'THE_ASK', 'SPIRAL'];

const throwingFetcher: Fetcher = async () => {
  throw new Error('network down');
};
const failingFetcher: Fetcher = async () => new Response('', { status: 503 });
const emptyReplyFetcher: Fetcher = async () =>
  new Response(JSON.stringify({ reply: '   ' }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });

describe('renderTurn fallback', () => {
  for (const beat of NON_DORMANT) {
    test(`a thrown fetch error falls back to an on-beat canned line for ${beat}`, async () => {
      const r = await renderTurn({ state: stateAt(beat), seedInt: SEED_INT, history: [], rng, fetcher: throwingFetcher });
      expect(r.source).toBe('canned');
      expect(r.text.length).toBeGreaterThan(0);
    });

    test(`a non-200 falls back to canned for ${beat}`, async () => {
      const r = await renderTurn({ state: stateAt(beat), seedInt: SEED_INT, history: [], rng, fetcher: failingFetcher });
      expect(r.source).toBe('canned');
      expect(r.text.length).toBeGreaterThan(0);
    });

    test(`an empty/whitespace reply falls back to canned for ${beat}`, async () => {
      const r = await renderTurn({ state: stateAt(beat), seedInt: SEED_INT, history: [], rng, fetcher: emptyReplyFetcher });
      expect(r.source).toBe('canned');
      expect(r.text.length).toBeGreaterThan(0);
    });
  }

  test('THE_ASK canned fallback interpolates the seed sum and reason', async () => {
    const r = await renderTurn({ state: stateAt('THE_ASK'), seedInt: SEED_INT, history: [], rng, fetcher: throwingFetcher });
    expect(r.text).toContain(seed.theSum);
    expect(r.text).toContain(seed.theReason);
    expect(r.text).not.toContain('{{');
  });

  test('the DORMANT greeting never fires a fetch and stays the static line', async () => {
    let called = false;
    const spy: Fetcher = async () => {
      called = true;
      return new Response('{}', { status: 200 });
    };
    const r = await renderTurn({ state: stateAt('DORMANT'), seedInt: SEED_INT, history: [], rng, fetcher: spy });
    expect(called).toBe(false);
    expect(r.source).toBe('canned');
    expect(r.text).toBe(GREETING);
  });

  test('a successful reply is used and marked as an llm turn', async () => {
    const okFetcher: Fetcher = async () =>
      new Response(JSON.stringify({ reply: 'oh my gosh hi' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    const r = await renderTurn({ state: stateAt('HOOKED'), seedInt: SEED_INT, history: [], rng, fetcher: okFetcher });
    expect(r.source).toBe('llm');
    expect(r.text).toBe('oh my gosh hi');
  });

  test('only the integer seed is sent over the wire (no persona text to inject)', async () => {
    let sentSeed: unknown;
    const capture: Fetcher = async (req) => {
      sentSeed = req.seed;
      return new Response(JSON.stringify({ reply: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    };
    await renderTurn({ state: stateAt('HOOKED'), seedInt: SEED_INT, history: [], rng, fetcher: capture });
    expect(typeof sentSeed).toBe('number');
    expect(sentSeed).toBe(SEED_INT);
  });

  test('every beat has at least one canned line', () => {
    for (const beat of ['DORMANT', ...NON_DORMANT] as Beat[]) {
      expect(CANNED[beat].length).toBeGreaterThan(0);
    }
  });
});
