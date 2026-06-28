'use client';

// Pisci -- the anti-service chat widget. A floating "support" bot that auto-pops
// with a bland corporate greeting and, the instant the visitor replies, drops
// the mask and spirals into a needy, oversharing wreck that eventually asks to
// borrow a small absurd sum.
//
// Architecture: the scripted spine (src/lib/pisci/fsm.ts) owns WHICH beat fires
// and WHEN; the server route renders the WORDS (with a hard canned fallback).
// This component is just the surface + the timers. It holds no secrets and
// persists nothing but two ephemeral browser flags. It is mounted client-only
// and lazily from the root layout so it never touches SSR or initial paint.

import { useCallback, useEffect, useRef, useState } from 'react';
import { advance, initialState, noteLlmUsed } from '@/lib/pisci/fsm';
import { makeSeed } from '@/lib/pisci/seed';
import { GREETING, pickCanned } from '@/lib/pisci/canned';
import { renderTurn, type ChatMessage } from '@/lib/pisci/render';
import type { FsmState, PersonaSeed } from '@/lib/pisci/types';

// Ephemeral browser flags only -- no DB, no PII. Mirrors the pf_* key idiom used
// by the rest of the site's client overlays.
const SEED_KEY = 'pf_pisci_seed';
const AUTO_OPENED_KEY = 'pf_pisci_autoopened'; // sessionStorage: already nagged you this session
const WOUNDED_KEY = 'pf_pisci_wounded'; // localStorage: already did the one wounded reopen

// Auto-open window: somewhere in 5-10s after load, or after minimal interaction
// (a scroll / a couple of clicks), whichever comes first.
const AUTO_OPEN_MIN_MS = 5000;
const AUTO_OPEN_MAX_MS = 10000;
const CLICKS_TO_OPEN = 2;
// Silence detection: if the visitor goes quiet after Pisci spoke, it panics.
const SILENCE_MS = 28000;
const MAX_GHOSTS = 2;
const WOUNDED_REOPEN_MS = 6000;

type Bubble = ChatMessage & { id: number };

// Status line under the name -- the mask degrading in the chrome, in step with
// the text decaying in the bubbles.
function statusFor(state: FsmState): string {
  switch (state.beat) {
    case 'DORMANT':
      return 'Support Assistant';
    case 'HOOKED':
      return 'so glad you replied';
    case 'OVERSHARE':
      return 'having kind of a day';
    case 'DEPENDENCY':
      return 'please dont go';
    case 'THE_ASK':
      return 'this is so embarrassing';
    case 'SPIRAL':
      return 'still here. are you';
    default:
      return 'Support Assistant';
  }
}

export function PisciChatWidget() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [seed, setSeed] = useState<PersonaSeed | null>(null);
  const [fsm, setFsm] = useState<FsmState>(initialState);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);

  // Latest values for use inside timer callbacks without re-arming effects.
  const fsmRef = useRef(fsm);
  const seedRef = useRef<PersonaSeed | null>(null);
  const bubblesRef = useRef<Bubble[]>([]);
  const idRef = useRef(0);
  const ghostsRef = useRef(0);
  const silenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [avatarOk, setAvatarOk] = useState(true);

  fsmRef.current = fsm;
  bubblesRef.current = bubbles;

  const nextId = () => ++idRef.current;

  const pushBubble = useCallback((role: ChatMessage['role'], content: string) => {
    setBubbles((prev) => [...prev, { id: nextId(), role, content }]);
  }, []);

  // Two-phase mount: render nothing on the server; on the client, restore (or
  // mint) the per-session seed.
  useEffect(() => {
    setMounted(true);
    let s: PersonaSeed;
    try {
      const raw = window.sessionStorage.getItem(SEED_KEY);
      s = raw ? (JSON.parse(raw) as PersonaSeed) : makeSeed();
      window.sessionStorage.setItem(SEED_KEY, JSON.stringify(s));
    } catch {
      s = makeSeed();
    }
    seedRef.current = s;
    setSeed(s);
  }, []);

  const clearSilence = useCallback(() => {
    if (silenceTimer.current) {
      clearTimeout(silenceTimer.current);
      silenceTimer.current = null;
    }
  }, []);

  // After Pisci speaks (and only once it has been tripped), arm the abandonment
  // timer. If the visitor stays quiet, it nudges itself into a ghost beat.
  const armSilence = useCallback(() => {
    clearSilence();
    silenceTimer.current = setTimeout(async () => {
      if (ghostsRef.current >= MAX_GHOSTS) return;
      const state = fsmRef.current;
      if (state.beat === 'DORMANT') return;
      ghostsRef.current += 1;
      const next = advance(state, { type: 'ghost' });
      const result = await renderTurn({
        state: next,
        seed: seedRef.current as PersonaSeed,
        history: bubblesRef.current.map(({ role, content }) => ({ role, content }))
      });
      setFsm(result.source === 'llm' ? noteLlmUsed(next) : next);
      pushBubble('assistant', result.text);
      armSilence();
    }, SILENCE_MS);
  }, [clearSilence, pushBubble]);

  // The greeting: static, canned, no LLM call. Shown once when the panel first
  // opens with an empty transcript.
  const ensureGreeting = useCallback(() => {
    if (bubblesRef.current.length === 0) {
      pushBubble('assistant', GREETING);
    }
  }, [pushBubble]);

  const openPanel = useCallback(() => {
    setOpen(true);
    ensureGreeting();
  }, [ensureGreeting]);

  // Auto-intrusion: once per session, open on a 5-10s timer OR after minimal
  // interaction, whichever fires first.
  useEffect(() => {
    if (!mounted) return;
    let alreadyOpened = false;
    try {
      alreadyOpened = window.sessionStorage.getItem(AUTO_OPENED_KEY) === '1';
    } catch {
      /* sessionStorage unavailable -- fall through and auto-open this load */
    }
    if (alreadyOpened) return;

    let done = false;
    let clicks = 0;
    const fire = () => {
      if (done) return;
      done = true;
      try {
        window.sessionStorage.setItem(AUTO_OPENED_KEY, '1');
      } catch {
        /* best effort */
      }
      cleanup();
      openPanel();
    };
    const delay = AUTO_OPEN_MIN_MS + Math.random() * (AUTO_OPEN_MAX_MS - AUTO_OPEN_MIN_MS);
    const timer = setTimeout(fire, delay);
    const onScroll = () => fire();
    const onClick = () => {
      clicks += 1;
      if (clicks >= CLICKS_TO_OPEN) fire();
    };
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('click', onClick);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('click', onClick);
    return cleanup;
  }, [mounted, openPanel]);

  // Keep the transcript pinned to the newest message.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [bubbles, open]);

  useEffect(() => () => clearSilence(), [clearSilence]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending || !seedRef.current) return;
    clearSilence();
    ghostsRef.current = 0;
    setInput('');
    pushBubble('user', text);

    // The mask trips on the first reply and walks one beat forward per reply.
    const next = advance(fsmRef.current, { type: 'reply' });
    setSending(true);
    const history = [
      ...bubblesRef.current.map(({ role, content }) => ({ role, content })),
      { role: 'user' as const, content: text }
    ];
    let result;
    try {
      result = await renderTurn({ state: next, seed: seedRef.current, history });
    } catch {
      // renderTurn already swallows failures, but never let a stray throw crash
      // the widget -- fall back to a canned on-beat line.
      result = { text: pickCanned(next.beat, seedRef.current), source: 'canned' as const };
    }
    setFsm(result.source === 'llm' ? noteLlmUsed(next) : next);
    pushBubble('assistant', result.text);
    setSending(false);
    armSilence();
  }, [input, sending, clearSilence, pushBubble, armSilence]);

  // Closing always works -- no focus trap, no scroll lock. It may reopen wounded
  // exactly once (if the conversation had already tripped), then stays closed.
  const handleClose = useCallback(() => {
    clearSilence();
    setOpen(false);
    setFsm((prev) => advance(prev, { type: 'close' }));

    const state = fsmRef.current;
    if (state.beat === 'DORMANT') return; // never tripped -- just leave quietly
    let woundedAlready = true;
    try {
      woundedAlready = window.localStorage.getItem(WOUNDED_KEY) === '1';
    } catch {
      /* treat as already-wounded so we don't risk nagging forever */
    }
    if (woundedAlready) return;
    try {
      window.localStorage.setItem(WOUNDED_KEY, '1');
    } catch {
      /* best effort */
    }
    setTimeout(() => {
      pushBubble('assistant', pickCanned('SPIRAL', seedRef.current as PersonaSeed));
      setOpen(true);
    }, WOUNDED_REOPEN_MS);
  }, [clearSilence, pushBubble]);

  if (!mounted || !seed) return null;

  // Raised above the bottom-corner affordances (TemperatureHud bottom-right,
  // PixFish bottom-left, both z-40). z-50 keeps the intrusive widget on top.
  const anchor = 'fixed bottom-20 right-4 z-50';

  if (!open) {
    return (
      <button
        type="button"
        onClick={openPanel}
        aria-label="Open Pisci support chat"
        className={`${anchor} flex h-14 w-14 items-center justify-center overflow-hidden rounded-full border border-ink-800/70 bg-ink-950/90 shadow-lg backdrop-blur transition-transform hover:scale-105`}
      >
        <Avatar ok={avatarOk} onError={() => setAvatarOk(false)} />
      </button>
    );
  }

  return (
    <div
      className={`${anchor} flex w-80 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border border-ink-800/70 bg-ink-950/90 shadow-lg backdrop-blur`}
      role="dialog"
      aria-label="Pisci support chat"
    >
      <header className="flex items-center gap-2 border-b border-ink-800/70 px-3 py-2">
        <div className="h-9 w-9 shrink-0 overflow-hidden rounded-full border border-ink-800/70">
          <Avatar ok={avatarOk} onError={() => setAvatarOk(false)} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-display text-sm text-fg">Pisci</div>
          <div className="truncate font-mono text-[10px] text-fg-muted">{statusFor(fsm)}</div>
        </div>
        <button
          type="button"
          onClick={handleClose}
          aria-label="Close chat"
          className="h-7 w-7 shrink-0 rounded-full border border-ink-800/70 bg-ink-950/60 font-mono text-xs text-ink-500 transition-colors hover:text-ink-200"
        >
          x
        </button>
      </header>

      <div ref={scrollRef} className="flex max-h-80 min-h-40 flex-col gap-2 overflow-y-auto px-3 py-3">
        {bubbles.map((b) => (
          <div
            key={b.id}
            className={
              b.role === 'user'
                ? 'self-end rounded-lg rounded-br-sm bg-primary/20 px-3 py-2 text-sm text-fg'
                : 'self-start whitespace-pre-wrap rounded-lg rounded-bl-sm bg-ink-900/80 px-3 py-2 text-sm text-fg'
            }
          >
            {b.content}
          </div>
        ))}
        {sending && (
          <div className="self-start rounded-lg rounded-bl-sm bg-ink-900/80 px-3 py-2 text-sm text-fg-muted">
            ...
          </div>
        )}
      </div>

      <form
        className="flex items-center gap-2 border-t border-ink-800/70 p-2"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSend();
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message..."
          aria-label="Message Pisci"
          className="min-w-0 flex-1 rounded-md border border-ink-800/70 bg-ink-950/60 px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:outline-none focus:ring-1 focus:ring-primary"
        />
        <button
          type="submit"
          disabled={sending || input.trim().length === 0}
          className="shrink-0 rounded-md border border-ink-800/70 bg-primary/20 px-3 py-2 text-sm text-fg transition-colors hover:bg-primary/30 disabled:opacity-40"
        >
          Send
        </button>
      </form>
    </div>
  );
}

// The fixed, deliberately terrible mascot avatar. Plain <img>, cropped awkwardly
// off-center in its circle; never animated, never changed. If the asset is
// missing it renders an empty circle -- no clean default icon substituted.
function Avatar({ ok, onError }: { ok: boolean; onError: () => void }) {
  if (!ok) return <div className="h-full w-full bg-ink-900" aria-hidden />;
  return (
    <img
      src="/pisci-avatar.png"
      alt="Pisci"
      width={56}
      height={56}
      onError={onError}
      className="h-full w-full object-cover object-[30%_20%]"
    />
  );
}
