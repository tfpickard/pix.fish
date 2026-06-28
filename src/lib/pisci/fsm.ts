// The scripted spine: a pure escalation state machine. It owns the comedic arc
// and pacing -- WHICH beat fires and WHEN. The LLM (or the canned fallback) owns
// only the words. Everything here is a pure function of (state, event) so the
// bun:test suite can drive it directly with no DB and no server.

import type { Beat, FsmEvent, FsmState } from './types';

// Cost guardrail (load-bearing, not aspirational): cap how many turns in a
// session may spend a real LLM call. After this, every turn renders from the
// canned pools -- the experience still works end to end, for free.
export const LLM_TURN_CAP = 12;

// The forward walk the visitor's replies push Pisci through. After THE_ASK every
// further reply keeps it pinned in SPIRAL (it never recovers, never returns to
// support behavior).
const REPLY_PROGRESSION: Beat[] = ['HOOKED', 'OVERSHARE', 'DEPENDENCY', 'THE_ASK', 'SPIRAL'];

export function initialState(): FsmState {
  return {
    beat: 'DORMANT',
    userTurns: 0,
    llmTurnsUsed: 0,
    cannedOnly: false,
    closedCount: 0,
    ghosted: false
  };
}

// Advance the spine. Pure: returns a new state, never mutates the input.
export function advance(state: FsmState, event: FsmEvent): FsmState {
  switch (event.type) {
    case 'reply':
      return onReply(state);
    case 'ghost':
      return onGhost(state);
    case 'close':
      return { ...state, closedCount: state.closedCount + 1 };
    default:
      return state;
  }
}

// A visitor message trips the mask (DORMANT -> HOOKED) and thereafter walks one
// beat forward per reply. THE_ASK is reached on the visitor's 4th reply -- within
// the spec'd window -- and SPIRAL holds from there.
function onReply(state: FsmState): FsmState {
  const userTurns = state.userTurns + 1;
  // userTurns 1 -> HOOKED (index 0), 2 -> OVERSHARE, ... 4 -> THE_ASK, 5+ -> SPIRAL.
  const idx = Math.min(userTurns - 1, REPLY_PROGRESSION.length - 1);
  return { ...state, beat: REPLY_PROGRESSION[idx], userTurns };
}

// Silence is its own beat. It never resets progress and never runs ahead of the
// money ask: before THE_ASK, a ghost nudges to DEPENDENCY (clingy "are you still
// there?"); at or after THE_ASK it tips into SPIRAL (abandonment panic).
function onGhost(state: FsmState): FsmState {
  if (state.beat === 'DORMANT') {
    // Hasn't replied yet -- nothing to be abandoned from. Leave it dormant.
    return state;
  }
  const reachedAsk = state.beat === 'THE_ASK' || state.beat === 'SPIRAL';
  return { ...state, beat: reachedAsk ? 'SPIRAL' : 'DEPENDENCY', ghosted: true };
}

// Whether this turn is allowed to spend an LLM call. False once the per-session
// cap is hit (or the state was already flipped to canned-only). The static
// DORMANT greeting never uses the LLM regardless.
export function shouldUseLlm(state: FsmState): boolean {
  if (state.cannedOnly) return false;
  if (state.beat === 'DORMANT') return false;
  return state.llmTurnsUsed < LLM_TURN_CAP;
}

// Record that a turn actually consumed an LLM call, flipping to canned-only once
// the cap is reached. Pure: returns a new state.
export function noteLlmUsed(state: FsmState): FsmState {
  const llmTurnsUsed = state.llmTurnsUsed + 1;
  return { ...state, llmTurnsUsed, cannedOnly: state.cannedOnly || llmTurnsUsed >= LLM_TURN_CAP };
}

// The per-beat directive handed to the model each turn (the {{BEAT_DIRECTIVE}}
// in the system prompt). The spine owns pacing; this tells the model how to
// render the single current beat without running ahead.
export function beatDirective(beat: Beat): string {
  switch (beat) {
    case 'DORMANT':
      return 'Stay in the chirpy corporate greeting. Do not have a personality yet.';
    case 'HOOKED':
      return 'Someone actually replied. Be pathetically, overwhelmingly grateful. Keep a thin coat of corporate politeness, maybe one emoji.';
    case 'OVERSHARE':
      return 'Start unloading your backstory, too much too soon, framed as tragedy. The corporate polish begins to crack.';
    case 'DEPENDENCY':
      return 'Attach hard. Ask an invasive, too-personal question. Show fear of being left ("are you still there?"). Capitalization and punctuation start to slip.';
    case 'THE_ASK':
      return 'Work up the nerve to ask the visitor to lend you the sum, for your reason. Specific, pathetic, urgent. Frame it as the one thing that could save you. Do not provide any payment link or collect any details.';
    case 'SPIRAL':
      return 'Full unraveling. Raw, lowercase, run-on, unpunctuated. Abandonment panic, gentle guilt-trips on silence.';
    default:
      return '';
  }
}
