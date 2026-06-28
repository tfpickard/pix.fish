'use client';

// "this or that" -- the taste quiz. Each round shows two images; the visitor
// picks the one that pulls them. The first pair is pre-seeded (instant); each
// subsequent pair is drawn adaptively from the visitor's evolving taste
// neighbourhood via /api/taste/next, with a fast fallback to the pre-seeded
// pool so play never blocks. Every pick also fires a pairwise vote that feeds
// the "most magnetic" ranking. Picks accumulate into a URL; the result page
// turns them into a taste vector + the gallery re-ranked as you.

import { useCallback, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { PathNode } from '@/lib/knn-path-types';

type Props = {
  pairs: [PathNode, PathNode][];
  // When set (a challenger's picked ids, csv), finishing routes to the
  // head-to-head comparison instead of the solo result. vsSkip carries the
  // challenger's rejected ids so both taste vectors factor in what each person
  // passed on (matching the solo result's math).
  vs?: string;
  vsSkip?: string;
};

const ROUNDS = 10;
const NEXT_TIMEOUT_MS = 1500;

export function TasteQuiz({ pairs, vs, vsSkip }: Props) {
  const router = useRouter();
  const total = Math.min(ROUNDS, Math.max(2, pairs.length));
  const [round, setRound] = useState(0);
  const [pair, setPair] = useState<[PathNode, PathNode] | null>(pairs[0] ?? null);
  const [busy, setBusy] = useState(false);

  // Synchronous guard: setBusy is async, so a fast double-tap (both images
  // before React re-renders) would otherwise pass the `busy` check twice and
  // record two votes / corrupt the picks. The ref flips before any await.
  const busyRef = useRef(false);
  const pickedRef = useRef<number[]>([]);
  const skippedRef = useRef<number[]>([]);
  const seenRef = useRef<Set<number>>(
    new Set(pairs[0] ? [pairs[0][0].imageId, pairs[0][1].imageId] : [])
  );
  const poolRef = useRef(1); // next index into the pre-seeded fallback pool

  const finish = useCallback(
    (pk: number[], sk: number[]) => {
      if (vs) {
        const as = vsSkip ? `&as=${encodeURIComponent(vsSkip)}` : '';
        router.push(`/taste/vs?a=${encodeURIComponent(vs)}${as}&b=${pk.join(',')}&bs=${sk.join(',')}`);
        return;
      }
      router.push(`/taste?p=${pk.join(',')}&s=${sk.join(',')}`);
    },
    [router, vs, vsSkip]
  );

  // Next pre-seeded pair whose images haven't been shown yet.
  const fallbackPair = useCallback((): [PathNode, PathNode] | null => {
    while (poolRef.current < pairs.length) {
      const p = pairs[poolRef.current++]!;
      if (!seenRef.current.has(p[0].imageId) && !seenRef.current.has(p[1].imageId)) return p;
    }
    return null;
  }, [pairs]);

  // Adaptive next pair, bounded by a short timeout so a slow API never stalls
  // the quiz -- on timeout/failure/empty we fall back to the pre-seeded pool.
  const nextPair = useCallback(async (): Promise<[PathNode, PathNode] | null> => {
    const ctrl = new AbortController();
    const t = window.setTimeout(() => ctrl.abort(), NEXT_TIMEOUT_MS);
    try {
      const params = new URLSearchParams({
        p: pickedRef.current.join(','),
        s: skippedRef.current.join(','),
        seen: [...seenRef.current].join(',')
      });
      const res = await fetch(`/api/taste/next?${params.toString()}`, { signal: ctrl.signal });
      if (res.ok) {
        const data = (await res.json()) as { a?: PathNode; b?: PathNode };
        if (data.a && data.b) return [data.a, data.b];
      }
    } catch {
      /* timeout or network error -- fall through to the pool */
    } finally {
      window.clearTimeout(t);
    }
    return fallbackPair();
  }, [fallbackPair]);

  const choose = useCallback(
    async (chosen: PathNode, other: PathNode) => {
      if (busyRef.current || !pair) return;
      busyRef.current = true;
      setBusy(true);

      // Pairwise vote -> "most magnetic". Fire-and-forget; keepalive lets the
      // final vote survive the navigation away on finish.
      void fetch('/api/taste/vote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ winner: chosen.imageId, loser: other.imageId }),
        keepalive: true
      }).catch(() => {});

      pickedRef.current = [...pickedRef.current, chosen.imageId];
      skippedRef.current = [...skippedRef.current, other.imageId];
      seenRef.current.add(chosen.imageId);
      seenRef.current.add(other.imageId);

      const nextRound = round + 1;
      if (nextRound >= total) {
        finish(pickedRef.current, skippedRef.current);
        return; // stay busy through navigation
      }

      const np = await nextPair();
      if (!np) {
        // Ran out of fresh images -- end with what we have rather than stall.
        finish(pickedRef.current, skippedRef.current);
        return;
      }
      seenRef.current.add(np[0].imageId);
      seenRef.current.add(np[1].imageId);
      setPair(np);
      setRound(nextRound);
      busyRef.current = false;
      setBusy(false);
    },
    [pair, round, total, finish, nextPair]
  );

  const progress = useMemo(() => Math.round((round / total) * 100), [round, total]);

  if (!pair) {
    return (
      <div className="space-y-4 pt-8">
        <h1 className="font-fungal-lite text-3xl text-ink-100">taste</h1>
        <p className="font-mono text-xs text-ink-500">reading your taste&hellip;</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 pt-8">
      <section className="space-y-1">
        <h1 className="font-fungal-lite text-3xl text-ink-100">what&rsquo;s your taste?</h1>
        <p className="font-mono text-xs text-ink-500">
          pick the one that pulls you. it learns as you go, then re-ranks the gallery as you.
        </p>
      </section>

      {/* Progress */}
      <div className="flex items-center gap-3">
        <div className="h-0.5 flex-1 bg-ink-800">
          <div className="h-full bg-primary transition-[width] duration-300" style={{ width: `${progress}%` }} />
        </div>
        <span className="font-mono text-[11px] text-ink-500">
          {round + 1} / {total}
        </span>
      </div>

      {/* The pair */}
      <div className={'grid grid-cols-2 gap-3 transition-opacity sm:gap-5 ' + (busy ? 'opacity-60' : '')}>
        {[pair[0], pair[1]].map((node, i) => (
          <button
            key={node.imageId}
            type="button"
            disabled={busy}
            onClick={() => choose(node, pair[i === 0 ? 1 : 0]!)}
            title={node.caption || node.slug}
            className="group relative aspect-[4/5] overflow-hidden rounded-lg border border-ink-800/80 bg-ink-950 transition-colors hover:border-primary/70 focus:border-primary focus:outline-none disabled:cursor-default"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={node.blobUrl}
              alt={node.caption || node.slug}
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
            />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink-950/90 to-transparent p-3 pt-10">
              <p className="line-clamp-2 font-mono text-[10px] text-ink-300 opacity-0 transition-opacity group-hover:opacity-100">
                {node.caption || node.slug}
              </p>
            </div>
          </button>
        ))}
      </div>

      <p className="text-center font-mono text-[11px] text-ink-600">
        tap an image &middot; no wrong answers &middot;{' '}
        <Link href="/taste/popular" prefetch={false} className="hover:text-ink-300">
          most magnetic
        </Link>
      </p>
    </div>
  );
}
