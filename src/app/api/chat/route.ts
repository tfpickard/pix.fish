// /api/chat -- the only server endpoint for the Pisci chat widget.
//
// Deliberately unlike the rest of the app's routes: NO auth gate (the widget
// serves anonymous browsers), NO database, and NO logging of message content.
// Conversation state is ephemeral client state; nothing here is persisted. The
// persona system prompt and the API key live in src/lib/ai/pisci-chat.ts and
// never reach the browser -- the client only ever POSTs this route.

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { renderPisciTurn, pisciLlmDisabled } from '@/lib/ai/pisci-chat';
import { beatDirective } from '@/lib/pisci/fsm';
import { getRequestIp, hashIp } from '@/lib/hash';
import { rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Cost/abuse guardrails on the way in: a short history window and bounded message
// sizes so a hostile client can't inflate the prompt.
const MAX_MESSAGES = 12;
const MAX_CONTENT = 600;

// Per-IP sliding-window cap on this unauthenticated, LLM-spending endpoint. A
// normal session makes at most ~12 LLM calls (the per-session cap), so 30/min is
// generous for real use but stops scripted abuse and runaway upstream cost.
const RATE_MAX = 30;
const RATE_WINDOW_MS = 60_000;

// The client supplies only two non-text levers, neither of which can steer the
// model: `beat` (an enum, used only to *select* a server-owned directive) and
// `seed` (an integer; the server reconstructs the fabricated persona from the
// fixed pools, so no client text is interpolated into the prompt). The directive
// string is never taken from the client.
const bodySchema = z.object({
  beat: z.enum(['DORMANT', 'HOOKED', 'OVERSHARE', 'DEPENDENCY', 'THE_ASK', 'SPIRAL']),
  seed: z.number().int().min(0).max(0x7fffffff),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(MAX_CONTENT)
      })
    )
    .max(MAX_MESSAGES)
});

export async function POST(req: Request) {
  // Rate-limit first, before any work. A 429 simply makes the client fall back
  // to its canned pools -- no crash, no empty bubble.
  const ipKey = `pisci-chat:${hashIp(getRequestIp(req))}`;
  if (!rateLimit(ipKey, RATE_MAX, RATE_WINDOW_MS)) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  // No LLM call on the static greeting -- the client never asks us to render it,
  // and the spine guards it too, but reject it here as well for defense in depth.
  if (parsed.data.beat === 'DORMANT') {
    return NextResponse.json({ error: 'no llm for greeting' }, { status: 400 });
  }

  // Disabled or unkeyed: 503 tells the client to fall back to its canned pools.
  if (pisciLlmDisabled()) {
    return NextResponse.json({ error: 'llm disabled' }, { status: 503 });
  }

  try {
    const reply = await renderPisciTurn({
      seedInt: parsed.data.seed,
      beat: parsed.data.beat,
      // Derived server-side from the validated beat -- never trusted from the
      // client, so it can't be used to override pacing or the taste fence.
      directive: beatDirective(parsed.data.beat),
      messages: parsed.data.messages
    });
    if (!reply) {
      return NextResponse.json({ error: 'no reply' }, { status: 503 });
    }
    return NextResponse.json({ reply });
  } catch {
    // Swallow the underlying error (it may echo prompt/key material); the client
    // just needs a non-200 to trigger its canned fallback.
    return NextResponse.json({ error: 'upstream failure' }, { status: 502 });
  }
}
