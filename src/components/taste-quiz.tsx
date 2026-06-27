'use client';

// "this or that" -- the taste quiz. Each round shows two images; the visitor
// picks the one that pulls them. Picks (and the rejected images) accumulate
// into a URL, and the result page turns them into a taste vector + the gallery
// re-ranked as you. Pairwise preference is a low-friction, addictive input and
// builds a clean direction in embedding space.

import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PathNode } from '@/lib/knn-path-types';

type Props = {
  pairs: [PathNode, PathNode][];
};

export function TasteQuiz({ pairs }: Props) {
  const router = useRouter();
  const [round, setRound] = useState(0);
  const [picked, setPicked] = useState<number[]>([]);
  const [skipped, setSkipped] = useState<number[]>([]);
  const [leaving, setLeaving] = useState(false);

  const total = pairs.length;
  const pair = pairs[round];

  const finish = useCallback(
    (pk: number[], sk: number[]) => {
      const p = pk.join(',');
      const s = sk.join(',');
      router.push(`/taste?p=${p}&s=${s}`);
    },
    [router]
  );

  const choose = useCallback(
    (chosen: PathNode, other: PathNode) => {
      if (leaving) return;
      const pk = [...picked, chosen.imageId];
      const sk = [...skipped, other.imageId];
      setPicked(pk);
      setSkipped(sk);
      if (round + 1 >= total) {
        setLeaving(true);
        finish(pk, sk);
      } else {
        setRound((r) => r + 1);
      }
    },
    [leaving, picked, skipped, round, total, finish]
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
          pick the one that pulls you. {total} rounds, then the gallery re-ranked as you.
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
      <div className="grid grid-cols-2 gap-3 sm:gap-5">
        {[pair[0], pair[1]].map((node, i) => (
          <button
            key={node.imageId}
            type="button"
            disabled={leaving}
            onClick={() => choose(node, pair[i === 0 ? 1 : 0]!)}
            title={node.caption || node.slug}
            className="group relative aspect-[4/5] overflow-hidden rounded-lg border border-ink-800/80 bg-ink-950 transition-colors hover:border-primary/70 focus:border-primary focus:outline-none disabled:opacity-60"
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

      <p className="text-center font-mono text-[11px] text-ink-600">tap an image &middot; no wrong answers</p>
    </div>
  );
}
