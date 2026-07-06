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
import { advance, initialState, noteLlmUsed, LLM_TURN_CAP } from '@/lib/pisci/fsm';
import { makeSeedFromInt, randomSeedInt } from '@/lib/pisci/seed';
import { GREETING, pickCanned } from '@/lib/pisci/canned';
import { renderTurn, type ChatMessage } from '@/lib/pisci/render';
import type { FsmState, PersonaSeed } from '@/lib/pisci/types';

// Ephemeral browser flags only -- no DB, no PII. Mirrors the pf_* key idiom used
// by the rest of the site's client overlays.
const SEED_KEY = 'pf_pisci_seed';
const AUTO_OPENED_KEY = 'pf_pisci_autoopened'; // sessionStorage: already nagged you this session
const WOUNDED_KEY = 'pf_pisci_wounded'; // localStorage: already did the one wounded reopen
const LLM_USED_KEY = 'pf_pisci_llm'; // sessionStorage: LLM turns spent, so the cap survives reloads

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
      return 'oh. ok hi';
    case 'OVERSHARE':
      return 'anyway so';
    case 'DEPENDENCY':
      return 'where r u going';
    case 'THE_ASK':
      return 'just spot me';
    case 'SPIRAL':
      return 'cool cool cool';
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
  // The integer session seed sent to the server; the persona above is derived
  // from it. Only the integer leaves the browser.
  const seedIntRef = useRef(0);
  const bubblesRef = useRef<Bubble[]>([]);
  const idRef = useRef(0);
  const ghostsRef = useRef(0);
  // Bumped on every close. An in-flight turn captures the value before its await
  // and bails if it changed -- so a reply that lands after the visitor dismissed
  // the panel is dropped instead of reviving the widget (no late bubble, no
  // re-armed silence timer firing hidden ghost requests).
  const turnSeqRef = useRef(0);
  const silenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const woundedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The current in-flight turn's aborter, so close/unmount can cancel the fetch
  // (and the upstream Anthropic call) instead of letting it spend tokens.
  const inFlightAbort = useRef<AbortController | null>(null);
  // Mirrors `open` for the auto-open click/scroll listeners, which would
  // otherwise count clicks on the widget's own controls (e.g. the close button).
  const openRef = useRef(open);
  // The open banner measures itself into --pisci-banner-h so other pinned
  // top-strip UI (the pix-fish stats bar, the lg gallery sidebars) can offset
  // below it instead of being covered.
  const bannerRef = useRef<HTMLDivElement | null>(null);
  const [avatarOk, setAvatarOk] = useState(true);

  fsmRef.current = fsm;
  bubblesRef.current = bubbles;
  openRef.current = open;

  const nextId = () => ++idRef.current;

  const pushBubble = useCallback((role: ChatMessage['role'], content: string) => {
    setBubbles((prev) => [...prev, { id: nextId(), role, content }]);
  }, []);

  // Two-phase mount: render nothing on the server; on the client, restore (or
  // mint) the per-session seed.
  useEffect(() => {
    setMounted(true);
    // Restore or mint the integer session seed; the persona is derived from it.
    let n: number;
    try {
      const raw = window.sessionStorage.getItem(SEED_KEY);
      n = raw && /^\d+$/.test(raw) ? Number(raw) : randomSeedInt();
      window.sessionStorage.setItem(SEED_KEY, String(n));
    } catch {
      n = randomSeedInt();
    }
    seedIntRef.current = n;
    const s = makeSeedFromInt(n);
    seedRef.current = s;
    setSeed(s);

    // Restore the LLM budget so a reload can't reset the per-session cap and
    // hand out another full set of paid calls. The transcript stays ephemeral;
    // only the spend counter carries over.
    try {
      const rawUsed = window.sessionStorage.getItem(LLM_USED_KEY);
      const used = rawUsed && /^\d+$/.test(rawUsed) ? Number(rawUsed) : 0;
      if (used > 0) {
        setFsm((prev) => ({
          ...prev,
          llmTurnsUsed: used,
          cannedOnly: prev.cannedOnly || used >= LLM_TURN_CAP
        }));
      }
    } catch {
      /* sessionStorage unavailable -- the cap is then per-load, which is fine */
    }
  }, []);

  // Persist the LLM spend counter so reloads/remounts keep counting against the
  // same per-session budget. The counter only ever increases, so we persist the
  // max -- this also stops the initial render (count 0) from clobbering a value
  // just restored from storage.
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(LLM_USED_KEY);
      const stored = raw && /^\d+$/.test(raw) ? Number(raw) : 0;
      if (fsm.llmTurnsUsed > stored) {
        window.sessionStorage.setItem(LLM_USED_KEY, String(fsm.llmTurnsUsed));
      }
    } catch {
      /* best effort */
    }
  }, [fsm.llmTurnsUsed]);

  const clearSilence = useCallback(() => {
    if (silenceTimer.current) {
      clearTimeout(silenceTimer.current);
      silenceTimer.current = null;
    }
  }, []);

  // Cancel a pending "wounded reopen" -- e.g. when the visitor reopens or replies
  // within the delay, so it can't fire an out-of-order ghost into a live chat.
  const clearWounded = useCallback(() => {
    if (woundedTimer.current) {
      clearTimeout(woundedTimer.current);
      woundedTimer.current = null;
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
      const seq = turnSeqRef.current;
      const ac = new AbortController();
      inFlightAbort.current?.abort();
      inFlightAbort.current = ac;
      const next = advance(state, { type: 'ghost' });
      const result = await renderTurn({
        state: next,
        seedInt: seedIntRef.current,
        history: bubblesRef.current.map(({ role, content }) => ({ role, content })),
        signal: ac.signal
      });
      // Only clear the shared aborter if this ghost is still the active turn -- a
      // newer send may have replaced it.
      if (inFlightAbort.current === ac) inFlightAbort.current = null;
      // Closed or superseded while the ghost reply was in flight: drop it.
      if (turnSeqRef.current !== seq) return;
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
    // Opening by any means (auto or a manual launcher click) counts as "already
    // nagged this session" so it doesn't auto-pop again on the next route.
    try {
      window.sessionStorage.setItem(AUTO_OPENED_KEY, '1');
    } catch {
      /* best effort */
    }
    // A manual reopen pre-empts a pending wounded reopen and invalidates any
    // in-flight ghost (turnSeqRef) so neither lands out of order.
    clearWounded();
    turnSeqRef.current += 1;
    setOpen(true);
    ensureGreeting();
  }, [ensureGreeting, clearWounded]);

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
    // Once the panel is open (manually or auto), stop counting -- otherwise a
    // click on the widget's own close button would tick the counter and reopen it.
    const onScroll = () => {
      if (openRef.current) return;
      fire();
    };
    const onClick = () => {
      if (openRef.current) return;
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
    // `open` is a dependency so that opening the panel (by any means) re-runs this
    // effect: the previous run's cleanup tears down the timer/listeners, and the
    // re-run early-returns because AUTO_OPENED_KEY is now set. Without it, a manual
    // open would leave the auto-open timer/listeners live to reopen after a close.
  }, [mounted, openPanel, open]);

  useEffect(
    () => () => {
      clearSilence();
      clearWounded();
      inFlightAbort.current?.abort();
    },
    [clearSilence, clearWounded]
  );

  // Publish the open banner's height as a global CSS var so the fixed pix-fish
  // stats bar and the lg sticky gallery sidebars can offset below it (they all
  // anchor to the same top strip). Closed -> 0px, so they sit at their normal
  // positions. A ResizeObserver keeps the var in sync as Pisci's line/status
  // reflows the banner height.
  useEffect(() => {
    const root = document.documentElement;
    const clear = () => root.style.setProperty('--pisci-banner-h', '0px');
    if (!open) {
      clear();
      return;
    }
    const el = bannerRef.current;
    if (!el) return;
    const apply = () => root.style.setProperty('--pisci-banner-h', `${el.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      ro.disconnect();
      clear();
    };
  }, [open]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending || !seedRef.current) return;
    clearSilence();
    // Invalidate any silence/ghost reply already in flight: clearing the timer
    // doesn't stop a renderTurn that already started, and a stale abandonment
    // line must not land after the visitor has just answered.
    turnSeqRef.current += 1;
    ghostsRef.current = 0;
    setInput('');
    pushBubble('user', text);

    // The mask trips on the first reply and walks one beat forward per reply.
    const next = advance(fsmRef.current, { type: 'reply' });
    setSending(true);
    const seq = turnSeqRef.current;
    const ac = new AbortController();
    // Cancel any overlapping in-flight turn (a racing double-submit, or a ghost
    // that fired just before this send) so it can't keep spending tokens.
    inFlightAbort.current?.abort();
    inFlightAbort.current = ac;
    const history = [
      ...bubblesRef.current.map(({ role, content }) => ({ role, content })),
      { role: 'user' as const, content: text }
    ];
    let result;
    try {
      result = await renderTurn({ state: next, seedInt: seedIntRef.current, history, signal: ac.signal });
    } catch {
      // renderTurn already swallows failures, but never let a stray throw crash
      // the widget -- fall back to a canned on-beat line.
      result = { text: pickCanned(next.beat, seedRef.current), source: 'canned' as const };
    }
    // Only this turn may clear shared state, and only while it is still the active
    // one. A stale turn (superseded by a newer send, or invalidated by close) must
    // not null a newer turn's aborter or re-enable the form under it.
    const active = inFlightAbort.current === ac;
    if (active) inFlightAbort.current = null;
    if (turnSeqRef.current !== seq) {
      // Discarded: closed, or a newer turn took over. Whoever invalidated this
      // turn (handleClose, or the newer send) owns the `sending` state.
      return;
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
    clearWounded();
    // Invalidate any in-flight turn so its late reply can't revive the widget,
    // and abort its fetch so the upstream call stops spending tokens.
    turnSeqRef.current += 1;
    inFlightAbort.current?.abort();
    inFlightAbort.current = null;
    // Close owns `sending` now that a discarded in-flight turn no longer clears
    // it -- otherwise the form could stay disabled after a send+close.
    setSending(false);
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
    const seq = turnSeqRef.current;
    woundedTimer.current = setTimeout(() => {
      woundedTimer.current = null;
      // The visitor reopened or replied within the delay (either bumps the token):
      // this wounded reopen is now stale -- don't fire a ghost into a live chat.
      if (turnSeqRef.current !== seq) return;
      // Drive the reopen through the spine (a 'ghost' = abandonment) so the beat,
      // status line, and bubble stay in sync and progress never regresses: an
      // early close reopens at DEPENDENCY, a late one at SPIRAL. Then re-arm the
      // silence timer so it can keep going if ignored again.
      const next = advance(fsmRef.current, { type: 'ghost' });
      setFsm(next);
      pushBubble('assistant', pickCanned(next.beat, seedRef.current as PersonaSeed));
      setOpen(true);
      armSilence();
    }, WOUNDED_REOPEN_MS);
  }, [clearSilence, clearWounded, pushBubble, armSilence]);

  if (!mounted || !seed) return null;

  // The banner is Pisci's mouth: show only its most recent line. A pending
  // reply renders as a typing indicator rather than echoing the visitor's own
  // text back at them in the bar. Earlier turns scroll off -- the escalating
  // beat still lands one line at a time, which is the whole gag. Scan from the
  // end for the newest assistant bubble (no copy/reverse allocation per render).
  let lastAssistant: Bubble | undefined;
  for (let i = bubbles.length - 1; i >= 0; i--) {
    if (bubbles[i].role === 'assistant') {
      lastAssistant = bubbles[i];
      break;
    }
  }

  if (!open) {
    // Closed: a small launcher in the bottom-right corner (raised above the
    // bottom-4 TemperatureHud). Kept out of the top strip so it never overlaps
    // the pix-fish stats controls that live there; the panel it opens is the
    // top banner. z-50 so it stays tappable over ambient corner overlays.
    return (
      <button
        type="button"
        onClick={openPanel}
        aria-label="Open Pisci support chat"
        className="fixed bottom-20 right-4 z-50 flex h-14 w-14 items-center justify-center overflow-hidden rounded-full border border-ink-800/70 bg-ink-950/90 shadow-lg backdrop-blur transition-transform hover:scale-105"
      >
        <Avatar ok={avatarOk} onError={() => setAvatarOk(false)} />
      </button>
    );
  }

  // Open: a slim banner that sits in normal flow directly beneath the nav, so
  // it reserves real space and the page body always renders below it instead
  // of being covered. `sticky top-14` (top-14 == the h-14 nav) then pins it
  // under the nav as the gallery scrolls past. It is mounted between the nav
  // and <main> in the root layout so this flow slot lands at the top of the
  // page. Full-bleed background with nav-matched centered content so it reads
  // as a secondary bar. Two stacked rows: Pisci's current line, then the reply
  // box.
  return (
    <div
      ref={bannerRef}
      className="sticky top-14 z-40 border-b border-ink-800/70 bg-ink-950/90 backdrop-blur"
      role="dialog"
      aria-label="Pisci support chat"
    >
      <div className="mx-auto max-w-6xl px-4 py-2">
        <div className="flex items-start gap-3">
          <div className="h-9 w-9 shrink-0 overflow-hidden rounded-full border border-ink-800/70">
            <Avatar ok={avatarOk} onError={() => setAvatarOk(false)} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="font-display text-sm leading-none text-fg">Pisci</span>
              <span className="truncate font-mono text-[10px] text-fg-muted">{statusFor(fsm)}</span>
            </div>
            <p className="line-clamp-2 text-sm leading-snug text-fg">
              {sending ? '...' : lastAssistant?.content ?? GREETING}
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close chat"
            className="h-7 w-7 shrink-0 rounded-full border border-ink-800/70 bg-ink-950/60 font-mono text-xs text-ink-500 transition-colors hover:text-ink-200"
          >
            x
          </button>
        </div>

        <form
          className="mt-2 flex items-center gap-2"
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
            className="min-w-0 flex-1 rounded-md border border-ink-800/70 bg-ink-950/60 px-3 py-1.5 text-sm text-fg placeholder:text-fg-muted focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            type="submit"
            disabled={sending || input.trim().length === 0}
            className="shrink-0 rounded-md border border-ink-800/70 bg-primary/20 px-3 py-1.5 text-sm text-fg transition-colors hover:bg-primary/30 disabled:opacity-40"
          >
            Send
          </button>
        </form>
      </div>
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
