import { describe, expect, test } from 'bun:test';
import {
  LLM_TURN_CAP,
  advance,
  beatDirective,
  initialState,
  noteLlmUsed,
  shouldUseLlm
} from '../src/lib/pisci/fsm';
import type { FsmState } from '../src/lib/pisci/types';

// The scripted spine is a pure function -- driven here directly, no DB, no server.

// Drive a sequence of reply events and collect the beat after each.
function replyWalk(turns: number): string[] {
  let state = initialState();
  const beats: string[] = [];
  for (let i = 0; i < turns; i++) {
    state = advance(state, { type: 'reply' });
    beats.push(state.beat);
  }
  return beats;
}

describe('escalation spine: reply progression', () => {
  test('starts DORMANT and only trips on the first reply', () => {
    const s = initialState();
    expect(s.beat).toBe('DORMANT');
    expect(advance(s, { type: 'reply' }).beat).toBe('HOOKED');
  });

  test('walks HOOKED -> OVERSHARE -> DEPENDENCY -> THE_ASK within the window', () => {
    const beats = replyWalk(4);
    expect(beats).toEqual(['HOOKED', 'OVERSHARE', 'DEPENDENCY', 'THE_ASK']);
  });

  test('reaches THE_ASK no later than the 4th reply', () => {
    const beats = replyWalk(4);
    expect(beats.indexOf('THE_ASK')).toBeLessThanOrEqual(3);
    expect(beats.indexOf('THE_ASK')).toBeGreaterThanOrEqual(0);
  });

  test('pins in SPIRAL after the ask and never returns to support', () => {
    const beats = replyWalk(8);
    expect(beats.slice(4)).toEqual(['SPIRAL', 'SPIRAL', 'SPIRAL', 'SPIRAL']);
    expect(beats).not.toContain('DORMANT');
  });
});

describe('escalation spine: ghost (silence) transitions', () => {
  test('a ghost before the ask nudges to DEPENDENCY, not ahead to the money', () => {
    let state = advance(initialState(), { type: 'reply' }); // HOOKED
    state = advance(state, { type: 'ghost' });
    expect(state.beat).toBe('DEPENDENCY');
    expect(state.ghosted).toBe(true);
  });

  test('a ghost at/after the ask tips into SPIRAL', () => {
    let state = initialState();
    for (let i = 0; i < 4; i++) state = advance(state, { type: 'reply' }); // THE_ASK
    state = advance(state, { type: 'ghost' });
    expect(state.beat).toBe('SPIRAL');
  });

  test('a ghost while still DORMANT does nothing (nothing to be abandoned from)', () => {
    const state = advance(initialState(), { type: 'ghost' });
    expect(state.beat).toBe('DORMANT');
    expect(state.ghosted).toBe(false);
  });

  test('ghost never resets reply progress', () => {
    let state = initialState();
    for (let i = 0; i < 2; i++) state = advance(state, { type: 'reply' }); // OVERSHARE
    const before = state.userTurns;
    state = advance(state, { type: 'ghost' });
    expect(state.userTurns).toBe(before);
  });
});

describe('escalation spine: close', () => {
  test('close increments closedCount without losing the beat', () => {
    let state = advance(initialState(), { type: 'reply' }); // HOOKED
    state = advance(state, { type: 'close' });
    expect(state.closedCount).toBe(1);
    expect(state.beat).toBe('HOOKED');
  });
});

describe('cost guardrail: per-session LLM cap', () => {
  test('flips to canned-only once the cap is reached', () => {
    let state: FsmState = initialState();
    state = advance(state, { type: 'reply' });
    expect(shouldUseLlm(state)).toBe(true);
    for (let i = 0; i < LLM_TURN_CAP; i++) {
      state = noteLlmUsed(state);
    }
    expect(state.cannedOnly).toBe(true);
    expect(state.llmTurnsUsed).toBe(LLM_TURN_CAP);
    expect(shouldUseLlm(state)).toBe(false);
  });

  test('never spends an LLM call on the static DORMANT greeting', () => {
    expect(shouldUseLlm(initialState())).toBe(false);
  });
});

describe('beat directives', () => {
  test('every non-dormant beat has a non-empty directive', () => {
    for (const beat of ['HOOKED', 'OVERSHARE', 'DEPENDENCY', 'THE_ASK', 'SPIRAL'] as const) {
      expect(beatDirective(beat).length).toBeGreaterThan(0);
    }
  });
});
