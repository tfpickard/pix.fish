'use client';

// "the daily" -- a daily semantic path puzzle. Start on image A, reach today's
// target B by repeatedly picking one of the current image's kNN neighbors,
// steered only by hotter/colder (did the graph distance to B drop?). Score is
// your move count vs par (the geodesic). Streak + a spoiler-free shareable
// result, and an end-screen that replays the optimal path via JourneyPlayer.
//
// The whole day's subgraph is embedded by the server, so play is pure client
// state -- no per-move round trips.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { JourneyPlayer } from '@/components/journey-player';
import type { PathNode } from '@/lib/knn-path-types';

type Props = {
  dailyNumber: number;
  dateStr: string;
  aId: number;
  bId: number;
  par: number;
  adjacency: Record<number, number[]>;
  distFromB: Record<number, number>;
  nodes: Record<number, PathNode>;
  optimalPath: PathNode[];
  optimalDist: number;
};

type Feedback = 'hot' | 'cold' | 'same';

const STORAGE_KEY = 'pf_daily_v1';

type Saved = { streak: number; lastNum: number; results: Record<number, number> };

function readSaved(): Saved {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { streak: 0, lastNum: 0, results: {}, ...JSON.parse(raw) };
  } catch {
    /* ignore corrupt / unavailable storage */
  }
  return { streak: 0, lastNum: 0, results: {} };
}

function fbEmoji(f: Feedback): string {
  return f === 'hot' ? '\u{1F525}' : f === 'cold' ? '\u{1F9CA}' : '\u{1F7E6}';
}

export function DailyGame({
  dailyNumber,
  aId,
  bId,
  par,
  adjacency,
  distFromB,
  nodes,
  optimalPath,
  optimalDist
}: Props) {
  const [current, setCurrent] = useState(aId);
  const [trail, setTrail] = useState<number[]>([aId]);
  const [feedback, setFeedback] = useState<Feedback[]>([]);
  const [won, setWon] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const [streak, setStreak] = useState<number | null>(null);
  const [solvedToday, setSolvedToday] = useState(false);
  const [copied, setCopied] = useState(false);

  const moves = feedback.length;
  const lastFb = feedback.length ? feedback[feedback.length - 1]! : null;

  // Load streak / "already solved" once on mount.
  useEffect(() => {
    const s = readSaved();
    setStreak(s.streak ?? 0);
    if (s.results?.[dailyNumber] != null) setSolvedToday(true);
  }, [dailyNumber]);

  const target = nodes[bId];
  const cur = nodes[current];

  const neighbors = useMemo(() => {
    const seen = new Set<number>();
    const out: PathNode[] = [];
    for (const id of adjacency[current] ?? []) {
      if (seen.has(id) || id === current) continue;
      seen.add(id);
      const n = nodes[id];
      if (n) out.push(n);
    }
    // Stable by id -- deliberately NOT by distance-to-target, so the card order
    // never reveals which move is best. Reading the images is the whole game.
    out.sort((x, y) => x.imageId - y.imageId);
    return out;
  }, [adjacency, current, nodes]);

  const recordWin = useCallback(
    (mv: number) => {
      try {
        const s = readSaved();
        if (s.results[dailyNumber] != null) {
          setStreak(s.streak ?? 0);
          return;
        }
        const nextStreak = s.lastNum === dailyNumber - 1 ? (s.streak ?? 0) + 1 : 1;
        const updated: Saved = {
          streak: nextStreak,
          lastNum: dailyNumber,
          results: { ...s.results, [dailyNumber]: mv }
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
        setStreak(nextStreak);
        setSolvedToday(true);
      } catch {
        /* storage unavailable -- streak just won't persist */
      }
    },
    [dailyNumber]
  );

  const pick = useCallback(
    (id: number) => {
      if (won) return;
      const prevDist = distFromB[current] ?? 99;
      const newDist = distFromB[id] ?? 99;
      const fb: Feedback = newDist < prevDist ? 'hot' : newDist > prevDist ? 'cold' : 'same';
      setFeedback((f) => [...f, fb]);
      setTrail((t) => [...t, id]);
      setCurrent(id);
      if (id === bId) {
        setWon(true);
        recordWin(moves + 1);
      }
    },
    [won, distFromB, current, bId, moves, recordWin]
  );

  const reset = useCallback(() => {
    setCurrent(aId);
    setTrail([aId]);
    setFeedback([]);
    setWon(false);
    setGaveUp(false);
    setCopied(false);
  }, [aId]);

  const shareText = useMemo(() => {
    const grid = feedback.map(fbEmoji).join('');
    const line = won ? `${moves} moves · par ${par}` : `gave up · par ${par}`;
    return `the daily #${dailyNumber}\n${line}\n${grid}${won ? '\u{1F3AF}' : ''}\nhttps://pix.fish/daily`;
  }, [feedback, won, moves, par, dailyNumber]);

  const share = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked -- the text is shown below for manual copy */
    }
  }, [shareText]);

  if (!cur || !target) {
    return (
      <div className="space-y-4 pt-8">
        <h1 className="font-fungal-lite text-3xl text-ink-100">the daily</h1>
        <p className="font-mono text-xs text-ink-500">today&rsquo;s puzzle could not be loaded.</p>
      </div>
    );
  }

  const ended = won || gaveUp;

  return (
    <div className="space-y-6 pt-8">
      {/* Header */}
      <section className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="space-y-1">
          <h1 className="font-fungal-lite text-3xl text-ink-100">the daily</h1>
          <p className="font-mono text-xs text-ink-500">
            walk from <span className="text-ink-300">A</span> to{' '}
            <span className="text-ink-300">the destination</span> through the semantic graph --
            hotter means closer. fewer moves is better; par is {par}.
          </p>
        </div>
        <div className="text-right font-mono text-[11px] text-ink-500">
          <div>#{dailyNumber}</div>
          {streak != null && streak > 0 ? (
            <div className="text-primary">{'\u{1F525}'} {streak} day streak</div>
          ) : null}
        </div>
      </section>

      {/* Destination (always visible) */}
      <section className="flex items-center gap-3 rounded-md border border-ink-800/80 bg-ink-900/30 p-3">
        <div className="h-16 w-16 shrink-0 overflow-hidden rounded bg-ink-950">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={target.blobUrl} alt={target.caption || target.slug} className="h-full w-full object-cover" />
        </div>
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-wider text-primary">destination</p>
          <p className="line-clamp-2 font-mono text-[11px] text-ink-300">{target.caption || target.slug}</p>
        </div>
      </section>

      {!ended ? (
        <>
          {/* Current image + hot/cold */}
          <section className="space-y-3">
            <div className="relative overflow-hidden rounded-lg border border-ink-800/80 bg-ink-950">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={cur.blobUrl}
                alt={cur.caption || cur.slug}
                className="max-h-[44vh] w-full object-contain"
              />
              <div className="absolute left-3 top-3 rounded-sm border border-ink-700/60 bg-ink-950/80 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-ink-300">
                {current === aId ? 'start' : `move ${moves}`}
              </div>
              {lastFb ? (
                <div
                  className={
                    'absolute right-3 top-3 rounded-md border px-2.5 py-1 font-mono text-xs ' +
                    (lastFb === 'hot'
                      ? 'border-orange-500/60 bg-orange-500/15 text-orange-300'
                      : lastFb === 'cold'
                        ? 'border-sky-500/60 bg-sky-500/15 text-sky-300'
                        : 'border-ink-600/60 bg-ink-800/50 text-ink-300')
                  }
                >
                  {lastFb === 'hot' ? '\u{1F525} warmer' : lastFb === 'cold' ? '\u{1F9CA} colder' : '→ no change'}
                </div>
              ) : null}
            </div>
            <p className="font-mono text-[11px] text-ink-400">{cur.caption || cur.slug}</p>
          </section>

          {/* Neighbor choices */}
          <section className="space-y-2">
            <p className="font-mono text-[10px] uppercase tracking-wider text-ink-500">
              your move -- pick the image that feels closest
            </p>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
              {neighbors.map((n) => {
                const visited = trail.includes(n.imageId);
                return (
                  <button
                    key={n.imageId}
                    type="button"
                    onClick={() => pick(n.imageId)}
                    title={n.caption || n.slug}
                    className="group relative aspect-square overflow-hidden rounded-md border border-ink-800/80 bg-ink-950 transition-colors hover:border-primary/60 focus:border-primary focus:outline-none"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={n.blobUrl}
                      alt={n.caption || n.slug}
                      className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.04]"
                    />
                    {n.imageId === bId ? (
                      <span className="absolute inset-x-0 bottom-0 bg-primary/80 py-0.5 text-center font-mono text-[9px] uppercase tracking-wider text-ink-950">
                        destination
                      </span>
                    ) : visited ? (
                      <span className="absolute right-1 top-1 rounded-sm bg-ink-950/80 px-1 font-mono text-[8px] text-ink-400">
                        seen
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </section>

          {/* Trail + give up */}
          <section className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1 overflow-x-auto">
              {trail.map((id, i) => {
                const n = nodes[id];
                if (!n) return null;
                return (
                  <span key={`${id}-${i}`} className="flex items-center gap-1">
                    {i > 0 ? <span className="font-mono text-[10px] text-ink-700">&rarr;</span> : null}
                    <span className="h-7 w-7 shrink-0 overflow-hidden rounded-sm border border-ink-800">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={n.blobUrl} alt="" className="h-full w-full object-cover" />
                    </span>
                  </span>
                );
              })}
            </div>
            <div className="flex items-center gap-3">
              <span className="font-mono text-[11px] text-ink-500">
                {moves} move{moves === 1 ? '' : 's'}
              </span>
              <button
                type="button"
                onClick={() => setGaveUp(true)}
                className="font-mono text-[11px] text-ink-500 hover:text-ink-300"
              >
                stuck? reveal the path
              </button>
            </div>
          </section>
        </>
      ) : (
        /* End screen */
        <section className="space-y-5">
          <div className="rounded-lg border border-primary/40 bg-primary/5 p-5">
            <p className="font-fungal-lite text-2xl text-ink-100">
              {won ? `solved in ${moves}` : 'the optimal path'}
              {won ? <span className="text-ink-500"> &middot; par {par}</span> : null}
            </p>
            <p className="mt-1 font-mono text-xs text-ink-400">
              {won
                ? moves <= par
                  ? 'a perfect line through the latent space.'
                  : `${moves - par} move${moves - par === 1 ? '' : 's'} over the geodesic -- not bad.`
                : solvedToday
                  ? 'already solved today -- here is the shortest route.'
                  : 'here is the shortest route the graph allows.'}
            </p>
            {won ? (
              <div className="mt-3 font-mono text-lg leading-none tracking-wide">
                {feedback.map((f, i) => (
                  <span key={i}>{fbEmoji(f)}</span>
                ))}
                <span>{'\u{1F3AF}'}</span>
              </div>
            ) : null}
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={share}
                className="rounded border border-primary/50 bg-primary/10 px-4 py-1.5 font-mono text-xs text-primary hover:bg-primary/20"
              >
                {copied ? 'copied!' : 'share result'}
              </button>
              <button
                type="button"
                onClick={reset}
                className="font-mono text-xs text-ink-500 hover:text-ink-300"
              >
                {won ? 'play again' : 'try it yourself'}
              </button>
              {streak != null && streak > 0 ? (
                <span className="font-mono text-[11px] text-primary">{'\u{1F525}'} {streak} day streak</span>
              ) : null}
            </div>
          </div>

          {/* Cinematic replay of the optimal A->B path. */}
          <div className="space-y-2">
            <p className="font-mono text-[10px] uppercase tracking-wider text-ink-500">
              the optimal path, {optimalPath.length} stops
            </p>
            <JourneyPlayer path={optimalPath} totalDist={optimalDist} />
          </div>
        </section>
      )}
    </div>
  );
}
