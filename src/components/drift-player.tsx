'use client';

// /drift -- the steerable fall through the deep. Each frame is the nearest image
// in caption-embedding space to a moving heading, so the gallery becomes a
// continuous semantic morph that advances on its own. You bend the fall: pull
// the heading toward what draws you, push it away from what does not, and dial
// "lucidity" -- how far each step leaps, i.e. how fast a seamless morph turns
// into surreal teleports. Your path glows across the atlas as you go, and you
// surface with a drift others can replay or branch from.
//
// The server is stateless: this component owns the trajectory and replays it to
// /api/drift/next each step. Visuals reuse the journey-player language (blurred
// cover + contained image + slow Ken-Burns + crossfade), no new deps.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { PathNode } from '@/lib/knn-path-types';
import { DriftAtlas } from '@/components/drift-atlas';

type Point = { imageId: number; x: number; y: number };

type Props = {
  initial: PathNode[]; // a single seed, or (replay) the full shared sequence
  points: Point[]; // UMAP projection for the minimap
  replay?: boolean;
};

const DWELL_MS = 4200;
const FADE_MS = 1100;
const VISITED_CAP = 120; // matches the server no-repeat window

const KENBURNS = [
  { origin: '30% 28%', scale: 1.08 },
  { origin: '70% 36%', scale: 1.1 },
  { origin: '42% 70%', scale: 1.07 },
  { origin: '62% 64%', scale: 1.09 }
];

function detailUrl(node: PathNode): string {
  return node.handle ? `/u/${node.handle}/${node.slug}` : `/${node.slug}`;
}

export function DriftPlayer({ initial, points, replay = false }: Props) {
  const [nodes, setNodes] = useState<PathNode[]>(initial);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [lucidity, setLucidity] = useState(0.35);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  // In replay we walk the shared sequence first; "keep drifting" flips to live.
  const [live, setLive] = useState(!replay);
  const [reduced, setReduced] = useState(false);
  const [pulse, setPulse] = useState<'toward' | 'away' | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFallback, setCopyFallback] = useState('');

  // Refs mirror state for use inside async callbacks without stale closures.
  const nodesRef = useRef(nodes);
  const idxRef = useRef(idx);
  const lucidityRef = useRef(lucidity);
  const doneRef = useRef(done);
  const loadingRef = useRef(false);
  const towardRef = useRef<number[]>([]);
  const awayRef = useRef<number[]>([]);
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useEffect(() => { idxRef.current = idx; }, [idx]);
  useEffect(() => { lucidityRef.current = lucidity; }, [lucidity]);
  useEffect(() => { doneRef.current = done; }, [done]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Fetch the next frame from the current trajectory and append it. Guarded so
  // only one request is ever in flight.
  const fetchNext = useCallback(async () => {
    if (loadingRef.current || doneRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const visited = nodesRef.current.map((n) => n.imageId).slice(-VISITED_CAP);
      const res = await fetch('/api/drift/next', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          visited,
          toward: towardRef.current.slice(-24),
          away: awayRef.current.slice(-24),
          lucidity: lucidityRef.current
        })
      });
      if (res.ok) {
        const data = (await res.json()) as { node?: PathNode | null; done?: boolean };
        if (data.done || !data.node) {
          doneRef.current = true;
          setDone(true);
        } else {
          const node = data.node;
          setNodes((ns) => (ns.some((n) => n.imageId === node.imageId) ? ns : [...ns, node]));
        }
      }
    } catch {
      /* network hiccup -- the advance effect will retry on the next tick */
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, []);

  // Keep one frame buffered ahead while falling live.
  useEffect(() => {
    if (!playing || done || !live) return;
    if (idx >= nodes.length - 1 && !loadingRef.current) void fetchNext();
  }, [idx, nodes.length, playing, done, live, fetchNext]);

  // Auto-advance once the next frame is buffered.
  useEffect(() => {
    if (!playing) return;
    if (idx >= nodes.length - 1) return; // wait for the buffer (or the end)
    const t = window.setTimeout(() => setIdx((i) => Math.min(i + 1, nodesRef.current.length - 1)), DWELL_MS);
    return () => window.clearTimeout(t);
  }, [playing, idx, nodes.length]);

  // In replay, pause when the shared sequence ends (offer "keep drifting").
  const atReplayEnd = replay && !live && idx >= nodes.length - 1;
  useEffect(() => {
    if (atReplayEnd) setPlaying(false);
  }, [atReplayEnd]);

  // Steer: record the pick, then discard any buffered-ahead frames so the bend
  // takes effect on the very next image instead of after the buffer drains.
  const steer = useCallback(
    (dir: 'toward' | 'away') => {
      const node = nodesRef.current[idx];
      if (!node) return;
      if (dir === 'toward') towardRef.current = [...towardRef.current, node.imageId];
      else awayRef.current = [...awayRef.current, node.imageId];
      setLive(true); // steering always resumes live drifting (e.g. mid-replay)
      setNodes((ns) => ns.slice(0, idx + 1));
      setPulse(dir);
      window.setTimeout(() => setPulse(null), 600);
      setPlaying(true);
    },
    [idx]
  );

  const onLucidity = useCallback((v: number) => {
    setLucidity(v);
    // Drop the buffer so the new leap-size applies to the next step immediately.
    setNodes((ns) => ns.slice(0, idxRef.current + 1));
  }, []);

  const keepDrifting = useCallback(() => {
    setLive(true);
    setDone(false);
    doneRef.current = false;
    setPlaying(true);
  }, []);

  const share = useCallback(async () => {
    const ids = nodesRef.current.slice(0, idxRef.current + 1).map((n) => n.imageId);
    const url = `${window.location.origin}/drift?d=${ids.join(',')}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setCopyFallback('');
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopyFallback(url);
    }
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === ' ') { e.preventDefault(); setPlaying((p) => !p); }
      else if (e.key === 'ArrowRight') setIdx((i) => Math.min(i + 1, nodesRef.current.length - 1));
      else if (e.key === 'ArrowLeft') setIdx((i) => Math.max(i - 1, 0));
      else if (e.key.toLowerCase() === 't') steer('toward');
      else if (e.key.toLowerCase() === 'x' || e.key.toLowerCase() === 'a') steer('away');
    },
    [steer]
  );

  const node = nodes[idx] ?? null;
  const trail = useMemo(() => nodes.slice(0, idx + 1).map((n) => n.imageId), [nodes, idx]);
  const waiting = playing && live && idx >= nodes.length - 1 && !done;

  if (!node) return null;

  return (
    <div
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="relative -mx-4 flex h-[82vh] flex-col overflow-hidden rounded-none bg-ink-950 outline-none sm:mx-0 sm:rounded-xl sm:border sm:border-ink-800/70"
    >
      {/* Image stack -- only a window around the current frame is mounted, so we
          never fire dozens of decodes. current-1 keeps the outgoing layer for
          the crossfade; current+1 preloads the next. */}
      <div className="relative flex-1 overflow-hidden">
        {nodes.map((n, i) => {
          if (Math.abs(i - idx) > 1) return null;
          const isCurrent = i === idx;
          const kb = KENBURNS[i % KENBURNS.length]!;
          return (
            <div
              key={n.imageId}
              className="absolute inset-0"
              style={{ opacity: isCurrent ? 1 : 0, transition: `opacity ${reduced ? 0 : FADE_MS}ms ease-in-out` }}
              aria-hidden={!isCurrent}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={n.blobUrl} alt="" aria-hidden="true" className="absolute inset-0 h-full w-full scale-110 object-cover opacity-40 blur-2xl" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={n.blobUrl}
                alt={n.caption || n.slug}
                className="absolute inset-0 h-full w-full object-contain"
                style={{
                  transformOrigin: kb.origin,
                  transform: isCurrent && !reduced ? `scale(${kb.scale})` : 'scale(1)',
                  transition: reduced ? 'none' : `transform ${DWELL_MS + FADE_MS}ms linear`
                }}
              />
            </div>
          );
        })}

        {/* Steer hit-zones: tap the left third to push away, the right two-thirds
            to pull toward. Big, gesture-first, and invisible so the art owns the
            frame. (Buttons below do the same for keyboard/AT.) */}
        <button
          type="button"
          onClick={() => steer('away')}
          aria-label="push away"
          className="absolute inset-y-0 left-0 z-10 w-1/3 cursor-w-resize focus:outline-none"
        />
        <button
          type="button"
          onClick={() => steer('toward')}
          aria-label="pull toward"
          className="absolute inset-y-0 right-0 z-10 w-2/3 cursor-e-resize focus:outline-none"
        />

        {/* Steer pulse: a brief edge glow confirming the bend. */}
        {pulse ? (
          <div
            className={
              'pointer-events-none absolute inset-0 z-20 transition-opacity duration-500 ' +
              (pulse === 'toward'
                ? 'bg-gradient-to-l from-primary/25 to-transparent'
                : 'bg-gradient-to-r from-rose-500/25 to-transparent')
            }
          />
        ) : null}

        {/* Top chrome */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-ink-950/80 to-transparent" />
        <div className="absolute inset-x-0 top-0 z-30 flex items-center justify-between p-4">
          <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-400">
            drift {waiting ? <span className="text-primary">&middot; falling&hellip;</span> : null}
          </span>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-ink-500">{trail.length} deep</span>
          </div>
        </div>

        {/* Atlas comet trail -- where you've drifted, top-right. */}
        {points.length > 0 ? (
          <div className="pointer-events-none absolute right-3 top-12 z-30 hidden sm:block">
            <DriftAtlas points={points} trail={trail} currentId={node.imageId} />
          </div>
        ) : null}

        {/* Bottom: caption + progress-of-the-fall hairline */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-ink-950 via-ink-950/80 to-transparent pt-16">
          <div className="mx-auto max-w-3xl px-6 pb-4">
            <div key={node.imageId} className="animate-in fade-in slide-in-from-bottom-2 duration-700">
              <Link href={detailUrl(node)} className="pointer-events-auto font-fungal-lite text-xl leading-snug text-ink-100 hover:text-primary md:text-2xl">
                {node.caption || node.slug}
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Transport + steer + lucidity */}
      <div className="z-30 space-y-3 border-t border-ink-800/70 bg-ink-950 px-4 py-3">
        {atReplayEnd ? (
          <div className="flex items-center justify-center gap-3">
            <span className="font-mono text-[11px] text-ink-500">end of this drift.</span>
            <button type="button" onClick={keepDrifting} className="rounded border border-primary/50 bg-primary/10 px-4 py-1.5 font-mono text-xs text-primary hover:bg-primary/20">
              keep drifting from here &rarr;
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
            <button type="button" onClick={() => steer('away')} className="rounded border border-rose-500/40 bg-rose-500/5 px-3 py-1.5 font-mono text-xs text-rose-300 hover:bg-rose-500/15">
              &larr; push away
            </button>
            <button type="button" onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'pause' : 'play'} className="rounded border border-ink-700 bg-ink-900 px-4 py-1.5 font-mono text-xs text-ink-200 hover:border-primary/50 hover:text-primary">
              {done ? 'drifted out' : playing ? '∥ pause' : '▶ fall'}
            </button>
            <button type="button" onClick={() => steer('toward')} className="rounded border border-primary/50 bg-primary/10 px-3 py-1.5 font-mono text-xs text-primary hover:bg-primary/20">
              pull toward &rarr;
            </button>
          </div>
        )}

        <div className="flex items-center gap-3">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-500">lucid</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={lucidity}
            onChange={(e) => onLucidity(Number(e.target.value))}
            aria-label="lucidity -- how far each step leaps"
            className="h-1 flex-1 cursor-pointer appearance-none rounded bg-ink-800 accent-primary"
          />
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-500">surreal</span>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-3 pt-0.5">
          <button type="button" onClick={share} className="font-mono text-[11px] text-primary hover:underline">
            {copied ? 'link copied!' : 'share this drift'}
          </button>
          <Link href={`/drift?from=${node.imageId}`} prefetch={false} className="font-mono text-[11px] text-ink-500 hover:text-ink-300">
            branch from here
          </Link>
          <Link href="/drift" prefetch={false} className="font-mono text-[11px] text-ink-500 hover:text-ink-300">
            new drift
          </Link>
          <span className="hidden font-mono text-[10px] text-ink-600 sm:inline">space &middot; &larr;/&rarr; &middot; t = toward &middot; x = away</span>
        </div>

        {copyFallback ? (
          <div className="space-y-1">
            <p className="font-mono text-[10px] text-ink-500">copy didn&rsquo;t work -- select and copy this:</p>
            <textarea readOnly value={copyFallback} rows={2} onFocus={(e) => e.currentTarget.select()} className="w-full resize-none rounded border border-ink-700 bg-ink-950 p-2 font-mono text-[11px] text-ink-300" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
