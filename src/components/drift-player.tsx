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
import { useRouter } from 'next/navigation';
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
const SHARE_CAP = 200; // matches the /drift page's MAX_REPLAY (replay/branch cap)

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
  // Bumped on every steer / lucidity change so an in-flight fetch built from the
  // old trajectory can be ignored when it resolves (see fetchNext).
  const genRef = useRef(0);
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
    const myGen = genRef.current;
    let errored = false;
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
      if (!res.ok) {
        errored = true; // 429/500 etc -- back off and let the effect retry
      } else {
        const data = (await res.json()) as { node?: PathNode | null; done?: boolean };
        // A steer / lucidity change since this request started supersedes it:
        // ignore the now-stale frame (computed from the old trajectory). The
        // prefetch effect re-runs when loading clears and fetches fresh.
        if (myGen !== genRef.current) return;
        if (data.done || !data.node) {
          doneRef.current = true;
          setDone(true);
        } else {
          const node = data.node;
          // Only reject a repeat within the server's no-repeat window (the last
          // VISITED_CAP). An older image legitimately resurfacing far into a long
          // drift must still append -- a global dedupe would drop it and stall.
          setNodes((ns) => {
            const recent = new Set(ns.slice(-VISITED_CAP).map((n) => n.imageId));
            return recent.has(node.imageId) ? ns : [...ns, node];
          });
        }
      }
    } catch {
      errored = true; // network hiccup -- back off and let the effect retry
    } finally {
      // On failure, back off before letting the prefetch effect retry so a
      // persistent 429/500 doesn't become a tight refetch loop; on success or a
      // supersede, clear immediately so the next (or steered) frame is fetched.
      const clear = () => { loadingRef.current = false; setLoading(false); };
      if (errored) window.setTimeout(clear, 1500);
      else clear();
    }
  }, []);

  // Keep one frame buffered ahead while falling live. `loading` is a dependency
  // so the effect re-evaluates when a fetch settles -- this is what retries after
  // a failed/superseded fetch instead of leaving the player stuck on "falling".
  useEffect(() => {
    if (!playing || done || !live) return;
    if (idx >= nodes.length - 1 && !loadingRef.current) void fetchNext();
  }, [idx, nodes.length, playing, done, live, loading, fetchNext]);

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
      genRef.current += 1; // supersede any in-flight fetch built from the old heading
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
    genRef.current += 1; // supersede any in-flight fetch built from the old lucidity
    // Drop the buffer so the new leap-size applies to the next step immediately.
    setNodes((ns) => ns.slice(0, idxRef.current + 1));
  }, []);

  const keepDrifting = useCallback(() => {
    setLive(true);
    setDone(false);
    doneRef.current = false;
    setPlaying(true);
  }, []);

  const router = useRouter();
  // "new drift" must always re-seed. From a replay/branch URL (?d= / ?from=)
  // navigating to bare /drift changes the route and refetches a new random seed;
  // when already on bare /drift the href is identical, so a Link would be a
  // no-op -- refresh() re-runs the (random-seeding) server page instead.
  const newDrift = useCallback(() => {
    if (typeof window !== 'undefined' && window.location.search) router.push('/drift');
    else router.refresh();
  }, [router]);

  const share = useCallback(async () => {
    // Cap to the last SHARE_CAP frames: a drift can run indefinitely, and an
    // unbounded id list would blow past URL limits and the page's MAX_REPLAY cap.
    const ids = nodesRef.current.slice(0, idxRef.current + 1).map((n) => n.imageId).slice(-SHARE_CAP);
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

  // Keyboard shortcuts at the WINDOW level. On a fresh /drift load focus is on
  // <body>, which is outside the player subtree, so a handler bound to the
  // wrapper would never receive the event (and after clicking the art, focus
  // lands on a tabIndex=-1 hidden steer zone the guard skips). A window listener
  // makes space / arrows / t / x actually reachable, while the same
  // interactive-target guard keeps it from stealing keys meant for the lucidity
  // slider, the copy textarea, or a focused button.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || (typeof t.closest === 'function' && t.closest('input, textarea, select, button')))) return;
      if (e.key === ' ') { e.preventDefault(); setPlaying((p) => !p); }
      else if (e.key === 'ArrowRight') setIdx((i) => Math.min(i + 1, nodesRef.current.length - 1));
      else if (e.key === 'ArrowLeft') setIdx((i) => Math.max(i - 1, 0));
      else if (e.key.toLowerCase() === 't') steer('toward');
      else if (e.key.toLowerCase() === 'x' || e.key.toLowerCase() === 'a') steer('away');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [steer]);

  const node = nodes[idx] ?? null;
  const trail = useMemo(() => nodes.slice(0, idx + 1).map((n) => n.imageId), [nodes, idx]);
  const waiting = playing && live && idx >= nodes.length - 1 && !done;

  if (!node) return null;

  return (
    <div
      className="relative -mx-4 flex h-[82vh] flex-col overflow-hidden rounded-none bg-ink-950 sm:mx-0 sm:rounded-xl sm:border sm:border-ink-800/70"
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
            to pull toward. Mouse/touch only -- tabIndex=-1 + aria-hidden keep them
            out of the tab order and AT (the visible, labeled steer buttons below
            cover keyboard/screen-reader users). onMouseDown preventDefault stops
            them from TAKING focus on click, so pointer steering doesn't park focus
            on an invisible button and disable the window keyboard shortcuts. */}
        <button
          type="button"
          onClick={() => steer('away')}
          onMouseDown={(e) => e.preventDefault()}
          tabIndex={-1}
          aria-hidden="true"
          className="absolute inset-y-0 left-0 z-10 w-1/3 cursor-w-resize focus:outline-none"
        />
        <button
          type="button"
          onClick={() => steer('toward')}
          onMouseDown={(e) => e.preventDefault()}
          tabIndex={-1}
          aria-hidden="true"
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
          <button type="button" onClick={newDrift} className="font-mono text-[11px] text-ink-500 hover:text-ink-300">
            new drift
          </button>
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
