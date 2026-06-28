// Client-side turn orchestrator: the seam between the scripted spine and the LLM
// flavor. Given the current state + seed + recent history, it asks the server
// route to render the current beat in Pisci's voice. On ANY failure -- LLM
// disabled, timeout, network error, non-200, empty body -- it falls back to an
// on-beat canned line. It never returns an empty string and never throws.
//
// The `fetcher` is injectable so the fallback test can drive a failing fetch
// without a network.

import { pickCanned } from './canned';
import { shouldUseLlm } from './fsm';
import type { FsmState, PersonaSeed } from './types';

// One chat bubble in the transcript. `role` matches the model's roles so the
// recent history can be replayed to the server cheaply.
export type ChatMessage = { role: 'user' | 'assistant'; content: string };

// The payload the client POSTs to /api/chat. No PII: just the fabricated seed,
// the current beat, and a short slice of recent turns for coherence. Note the
// beat directive is NOT sent -- the server derives it from `beat` itself, so a
// client can't hand-craft a directive to steer the model.
export type ChatRequest = {
  beat: FsmState['beat'];
  seed: PersonaSeed;
  messages: ChatMessage[];
};

export type RenderResult = { text: string; source: 'llm' | 'canned' };

// Injectable for tests; defaults to a real POST with a hard timeout.
export type Fetcher = (req: ChatRequest, signal: AbortSignal) => Promise<Response>;

// How many recent turns we forward for coherence. Kept short -- this is a cost
// guardrail too (smaller prompts, cheaper calls), not just tidiness.
const HISTORY_WINDOW = 6;
const REQUEST_TIMEOUT_MS = 8000;

const defaultFetcher: Fetcher = (req, signal) =>
  fetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
    signal
  });

export async function renderTurn(args: {
  state: FsmState;
  seed: PersonaSeed;
  history: ChatMessage[];
  rng?: () => number;
  fetcher?: Fetcher;
}): Promise<RenderResult> {
  const { state, seed, history, rng = Math.random } = args;
  const fetcher = args.fetcher ?? defaultFetcher;

  // Spine says no LLM this turn (cap reached, or canned-only): go straight to the
  // pool. No wasted call.
  if (!shouldUseLlm(state)) {
    return { text: pickCanned(state.beat, seed, rng), source: 'canned' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const req: ChatRequest = {
      beat: state.beat,
      seed,
      messages: history.slice(-HISTORY_WINDOW)
    };
    const res = await fetcher(req, controller.signal);
    if (!res.ok) return fallback(state, seed, rng);
    const data = (await res.json().catch(() => null)) as { reply?: unknown } | null;
    const reply = typeof data?.reply === 'string' ? data.reply.trim() : '';
    if (!reply) return fallback(state, seed, rng);
    return { text: reply, source: 'llm' };
  } catch {
    // Timeout, abort, network, or parse error -- the bit must survive all of it.
    return fallback(state, seed, rng);
  } finally {
    clearTimeout(timer);
  }
}

function fallback(state: FsmState, seed: PersonaSeed, rng: () => number): RenderResult {
  return { text: pickCanned(state.beat, seed, rng), source: 'canned' };
}
