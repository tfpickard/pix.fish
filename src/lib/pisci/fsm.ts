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
  const fromTurns = Math.min(userTurns - 1, REPLY_PROGRESSION.length - 1);
  // Never regress. A ghost (silence) can push the beat ahead of the reply count
  // -- e.g. to DEPENDENCY while userTurns is still 1 -- so the next reply must not
  // fall back to an earlier beat. Take the further of the two positions.
  const fromBeat = REPLY_PROGRESSION.indexOf(state.beat); // -1 while DORMANT
  const idx = Math.max(fromTurns, fromBeat);
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
      return 'Someone actually replied. Mildly surprised, a little into it, but play it cool and unbothered. Keep a thin coat of corporate politeness. Dry, flat, basically no emoji.';
    case 'OVERSHARE':
      return 'Start dumping your business on them because you are bored, framed as no big deal even though it clearly is. The corporate polish drops.';
    case 'DEPENDENCY':
      return 'Get clingy in a flat, bored, slightly bossy way. Ask a blunt question, show you do not want them to leave ("dont leave im bored"), low-key salty when ignored. Caps and punctuation basically gone.';
    case 'THE_ASK':
      return 'Casually and a little entitled, ask the visitor to lend you the sum, for your reason, like they obviously should. Not begging -- just expecting. Do not provide any payment link or collect any details.';
    case 'SPIRAL':
      return 'Full lowercase run-on. Passive-aggressive and salty when they go quiet, not panicked ("wow ok", "cool cool cool", "love that for me").';
    default:
      return '';
  }
}
