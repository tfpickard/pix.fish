import { afterEach, describe, expect, test } from 'bun:test';
import { advance, initialState, noteLlmUsed, shouldUseLlm, LLM_TURN_CAP } from '../src/lib/pisci/fsm';
import { PISCI_MAX_TOKENS, clampMaxTokens, pisciLlmDisabled } from '../src/lib/ai/pisci-chat';

// Cost guardrails must be ENFORCED, not just configured.

describe('max_tokens ceiling', () => {
  test('is a short cap in the spec range (80-120)', () => {
    expect(PISCI_MAX_TOKENS).toBeLessThanOrEqual(120);
    expect(PISCI_MAX_TOKENS).toBeGreaterThanOrEqual(80);
  });

  test('clamps any larger request down to the ceiling', () => {
    expect(clampMaxTokens(100000)).toBe(PISCI_MAX_TOKENS);
    expect(clampMaxTokens(PISCI_MAX_TOKENS + 1)).toBe(PISCI_MAX_TOKENS);
  });

  test('leaves a smaller request alone', () => {
    expect(clampMaxTokens(50)).toBe(50);
  });

  test('falls back to the ceiling on a nonsensical request', () => {
    expect(clampMaxTokens(0)).toBe(PISCI_MAX_TOKENS);
    expect(clampMaxTokens(-10)).toBe(PISCI_MAX_TOKENS);
    expect(clampMaxTokens(Number.NaN)).toBe(PISCI_MAX_TOKENS);
  });
});

describe('per-session LLM-call cap', () => {
  test('after LLM_TURN_CAP spent turns the session is canned-only', () => {
    let state = advance(initialState(), { type: 'reply' });
    let spent = 0;
    while (shouldUseLlm(state)) {
      state = noteLlmUsed(state);
      spent += 1;
      // Guard the loop so a regression that never flips the cap fails loudly
      // instead of hanging.
      expect(spent).toBeLessThanOrEqual(LLM_TURN_CAP);
    }
    expect(spent).toBe(LLM_TURN_CAP);
    expect(state.cannedOnly).toBe(true);
    expect(shouldUseLlm(state)).toBe(false);
  });
});

describe('LLM disable flag', () => {
  const prevFlag = process.env.PISCI_LLM_DISABLED;
  const prevKey = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (prevFlag === undefined) delete process.env.PISCI_LLM_DISABLED;
    else process.env.PISCI_LLM_DISABLED = prevFlag;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  });

  test('the env flag disables the LLM path even with a key present', () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    delete process.env.PISCI_LLM_DISABLED;
    expect(pisciLlmDisabled()).toBe(false);
    process.env.PISCI_LLM_DISABLED = '1';
    expect(pisciLlmDisabled()).toBe(true);
  });

  test('a missing key also counts as disabled', () => {
    delete process.env.PISCI_LLM_DISABLED;
    delete process.env.ANTHROPIC_API_KEY;
    expect(pisciLlmDisabled()).toBe(true);
  });
});
