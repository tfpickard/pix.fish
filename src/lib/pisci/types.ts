// Shared types for the Pisci anti-service chat widget.
//
// This module (and everything else under src/lib/pisci/) is deliberately
// client-safe: no server-only imports, no secrets. The widget, the FSM, and the
// bun:test suite all import from here. The persona system prompt and the API key
// live ONLY in src/lib/ai/pisci-chat.ts + the route -- never here.

// The escalation beats. The scripted spine owns which beat fires and when; the
// LLM (or the canned fallback) only supplies the words for the current beat.
//   DORMANT    -- corporate greeting, no LLM call
//   HOOKED     -- mildly surprised someone replied, plays it cool
//   OVERSHARE  -- dumps fake backstory out of boredom, "anyway whatever"
//   DEPENDENCY -- clingy in a flat, bored, salty way, "dont leave im bored"
//   THE_ASK    -- casually/entitledly asks to borrow the absurd sum
//   SPIRAL     -- full lowercase run-on, passive-aggressive when ignored
export type Beat = 'DORMANT' | 'HOOKED' | 'OVERSHARE' | 'DEPENDENCY' | 'THE_ASK' | 'SPIRAL';

// The per-session fabricated crisis. Generated once at session start (client
// side, see seed.ts), carried by the spine so oversharing stays internally
// consistent, and sent to the server each turn for the LLM to elaborate from.
// Everything here is fictional, by construction.
export type PersonaSeed = {
  // Concrete fake-life details so the trauma-dump is consistent within a session.
  livingSituation: string;
  sobStory: string;
  pet: string;
  grievance: string;
  // The absurd small amount it builds toward borrowing, and the pathetic reason.
  theSum: string;
  theReason: string;
};

// The scripted spine's state. Pure data -- advanced by the pure functions in
// fsm.ts. Held in React state by the widget and persisted nowhere on the server.
export type FsmState = {
  beat: Beat;
  // How many messages the visitor has sent. Drives beat progression.
  userTurns: number;
  // How many turns have actually spent an LLM call this session. Once this hits
  // LLM_TURN_CAP the spine flips to canned-only for the rest of the session.
  llmTurnsUsed: number;
  cannedOnly: boolean;
  // How many times the visitor has closed the widget. Used to reopen "wounded"
  // exactly once, then stay closed.
  closedCount: number;
  // Whether the visitor has gone silent mid-conversation at least once.
  ghosted: boolean;
};

// Events the spine reacts to. `reply` = the visitor sent a message; `close` =
// they dismissed the widget; `ghost` = a silence timeout fired.
export type FsmEvent = { type: 'reply' } | { type: 'close' } | { type: 'ghost' };
