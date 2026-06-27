'use client';

// Cinematic playback of a geodesic path through the kNN graph. Where
// PathFilmstrip lays the path out as a scannable strip, this plays it as a
// full-screen narrated drift: each image holds the frame with a slow Ken-Burns
// push, crossfades into the next semantic neighbor, and its caption surfaces as
// narration. The point is to *feel* the gradient between two images instead of
// just listing the stops.
//
// Pure React + CSS -- no new deps. The path nodes are already hydrated by the
// /connect server render, so this adds no data fetching.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { PathNode } from '@/lib/knn-path-types';

type Props = {
  path: PathNode[];
  totalDist: number;
};

// How long each image holds the frame before the crossfade to the next.
const DWELL_MS = 4200;
// Crossfade / caption transition length.
const FADE_MS = 1100;

// Per-stop Ken-Burns end-states. Cycling through a few focal points keeps the
// motion from feeling like the same zoom every time. transform-origin sets
// where the push converges; the scale is gentle so nothing important leaves
// the frame.
const KENBURNS = [
  { origin: '30% 28%', scale: 1.09 },
  { origin: '72% 35%', scale: 1.11 },
  { origin: '40% 72%', scale: 1.08 },
  { origin: '64% 66%', scale: 1.1 },
  { origin: '50% 45%', scale: 1.12 }
];

function detailUrl(node: PathNode): string {
  return node.handle ? `/u/${node.handle}/${node.slug}` : `/${node.slug}`;
}

export function JourneyPlayer({ path, totalDist }: Props) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [reduced, setReduced] = useState(false);
  const overlayRef = useRef<HTMLDivElement | null>(null);

  const last = path.length - 1;
  const atEnd = current >= last;

  // Respect the visitor's reduced-motion preference: instant cuts, no push.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const start = useCallback(() => {
    setCurrent(0);
    setPlaying(true);
    setOpen(true);
  }, []);

  const close = useCallback(() => setOpen(false), []);
  const next = useCallback(() => setCurrent((c) => Math.min(c + 1, last)), [last]);
  const prev = useCallback(() => setCurrent((c) => Math.max(c - 1, 0)), []);

  // Lock body scroll while the overlay owns the screen; focus it for keys.
  // Remember what had focus (the launch button) so we can hand it back on
  // close -- otherwise keyboard / screen-reader users land at the top of the
  // tab order instead of where they left off.
  useEffect(() => {
    if (!open) return;
    const launcher = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    overlayRef.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      launcher?.focus?.();
    };
  }, [open]);

  // Auto-advance. Stops (rather than loops) at the final image so the journey
  // has a clear arrival; the user can replay or step manually from there.
  useEffect(() => {
    if (!open || !playing || atEnd) return;
    const id = window.setTimeout(() => setCurrent((c) => Math.min(c + 1, last)), DWELL_MS);
    return () => window.clearTimeout(id);
  }, [open, playing, current, atEnd, last]);

  // Pause auto-advance once we arrive at B.
  useEffect(() => {
    if (open && atEnd) setPlaying(false);
  }, [open, atEnd]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === ' ') {
        e.preventDefault();
        setPlaying((p) => !p);
      } else if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') prev();
    },
    [close, next, prev]
  );

  if (path.length < 2) return null;

  const node = path[current]!;
  const progressPct = (current / last) * 100;

  return (
    <>
      {/* Inline launch control, sits above the filmstrip. */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={start}
          className="group inline-flex items-center gap-2 rounded-md border border-primary/50 bg-primary/10 px-4 py-2 font-mono text-xs text-primary transition-colors hover:bg-primary/20"
        >
          <span aria-hidden="true" className="text-sm leading-none transition-transform group-hover:translate-x-0.5">
            &#9658;
          </span>
          play the journey
        </button>
        <span className="font-mono text-[11px] text-ink-500">
          a {path.length}-stop drift from A to B &middot; press play and let it carry you
        </span>
      </div>

      {open ? (
        <div
          ref={overlayRef}
          role="dialog"
          aria-modal="true"
          aria-label="semantic journey playback"
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="fixed inset-0 z-50 flex flex-col bg-ink-950 outline-none"
        >
          {/* Image stack. Every node is mounted; only the current is opaque, so
              the crossfade is a pure opacity transition and the Ken-Burns push
              is a transform transition that retriggers when current changes. */}
          <div className="relative flex-1 overflow-hidden">
            {path.map((n, idx) => {
              // Only mount a small window around the current stop. findPath()
              // has no max length, and each stop is two full-res <img>s, so
              // mounting the whole path could fire dozens of simultaneous
              // downloads/decodes. current-1 keeps the outgoing layer alive for
              // the crossfade; current+1 preloads the next so the fade is ready.
              if (Math.abs(idx - current) > 1) return null;
              const isCurrent = idx === current;
              const kb = KENBURNS[idx % KENBURNS.length]!;
              return (
                <div
                  key={n.imageId}
                  className="absolute inset-0"
                  style={{
                    opacity: isCurrent ? 1 : 0,
                    transition: `opacity ${reduced ? 0 : FADE_MS}ms ease-in-out`
                  }}
                  aria-hidden={!isCurrent}
                >
                  {/* Blurred cover fills the letterbox so contained art floats
                      on a tone pulled from the image itself. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={n.blobUrl}
                    alt=""
                    aria-hidden="true"
                    className="absolute inset-0 h-full w-full scale-110 object-cover opacity-40 blur-2xl"
                  />
                  {/* Sharp, contained image carrying the slow push. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={n.blobUrl}
                    alt={n.caption || n.slug}
                    className="absolute inset-0 h-full w-full object-contain"
                    style={{
                      transformOrigin: kb.origin,
                      transform: isCurrent && !reduced ? `scale(${kb.scale})` : 'scale(1)',
                      transition: reduced
                        ? 'none'
                        : `transform ${DWELL_MS + FADE_MS}ms linear`
                    }}
                  />
                </div>
              );
            })}

            {/* Top gradient + chrome */}
            <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-ink-950/80 to-transparent" />
            <div className="absolute inset-x-0 top-0 flex items-center justify-between p-4">
              <span className="font-mono text-[11px] uppercase tracking-wider text-ink-400">
                semantic journey
              </span>
              <button
                type="button"
                onClick={close}
                aria-label="close"
                className="pointer-events-auto rounded border border-ink-700/70 bg-ink-950/60 px-2 py-1 font-mono text-xs text-ink-300 hover:border-ink-500 hover:text-ink-100"
              >
                close &#10005;
              </button>
            </div>

            {/* Bottom gradient + narration */}
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink-950 via-ink-950/85 to-transparent pt-20">
              <div className="mx-auto max-w-3xl px-6 pb-5">
                {/* key=current remounts the block so the caption re-animates in
                    on every stop. */}
                <div key={current} className="animate-in fade-in slide-in-from-bottom-2 duration-700">
                  <p className="mb-2 font-mono text-[11px] text-ink-500">
                    {current === 0
                      ? 'A'
                      : current === last
                        ? 'B'
                        : `step ${current}`}{' '}
                    &middot; {current + 1} / {path.length}
                  </p>
                  <Link
                    href={detailUrl(node)}
                    className="pointer-events-auto font-fungal-lite text-xl leading-snug text-ink-100 hover:text-primary md:text-2xl"
                  >
                    {node.caption || node.slug}
                  </Link>
                </div>
              </div>

              {/* Overall A->B progress -- fills smoothly as you advance. */}
              <div className="h-0.5 w-full bg-ink-800/70">
                <div
                  className="h-full bg-primary"
                  style={{ width: `${progressPct}%`, transition: 'width 900ms ease' }}
                />
              </div>
            </div>
          </div>

          {/* Transport bar */}
          <div className="flex items-center justify-center gap-4 border-t border-ink-800/70 bg-ink-950 px-4 py-3">
            <button
              type="button"
              onClick={prev}
              disabled={current === 0}
              aria-label="previous"
              className="rounded px-3 py-1 font-mono text-xs text-ink-300 hover:text-ink-100 disabled:opacity-30"
            >
              &#8249; prev
            </button>
            {atEnd ? (
              <button
                type="button"
                onClick={start}
                className="rounded border border-primary/50 bg-primary/10 px-4 py-1.5 font-mono text-xs text-primary hover:bg-primary/20"
              >
                &#8634; replay
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setPlaying((p) => !p)}
                aria-label={playing ? 'pause' : 'play'}
                className="rounded border border-primary/50 bg-primary/10 px-4 py-1.5 font-mono text-xs text-primary hover:bg-primary/20"
              >
                {playing ? '∥ pause' : '▶ play'}
              </button>
            )}
            <button
              type="button"
              onClick={next}
              disabled={atEnd}
              aria-label="next"
              className="rounded px-3 py-1 font-mono text-xs text-ink-300 hover:text-ink-100 disabled:opacity-30"
            >
              next &#8250;
            </button>
            <span className="ml-2 hidden font-mono text-[10px] text-ink-600 sm:inline">
              total distance {totalDist.toFixed(3)} &middot; space / &larr; &rarr; / esc
            </span>
          </div>
        </div>
      ) : null}
    </>
  );
}
