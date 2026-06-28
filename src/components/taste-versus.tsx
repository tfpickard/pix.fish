'use client';

// Head-to-head taste comparison. The URL encodes both people's picks, so the
// card reproduces server-side and is itself shareable. Renders only NSFW-gated
// matches (computed on the server).

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { PathNode } from '@/lib/knn-path-types';

type Props = {
  alignment: number;
  both: PathNode[];
  aOnly: PathNode[];
  bOnly: PathNode[];
};

function detailUrl(node: PathNode): string {
  return node.handle ? `/u/${node.handle}/${node.slug}` : `/${node.slug}`;
}

function label(score: number): string {
  if (score >= 82) return 'kindred spirits';
  if (score >= 66) return 'well aligned';
  if (score >= 50) return 'complementary';
  if (score >= 34) return 'different wavelengths';
  return 'opposite poles';
}

function Thumbs({ nodes }: { nodes: PathNode[] }) {
  if (nodes.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {nodes.map((n) => (
        <Link
          key={n.imageId}
          href={detailUrl(n)}
          title={n.caption || n.slug}
          className="h-16 w-16 shrink-0 overflow-hidden rounded-md border border-ink-800/80 bg-ink-950 transition-colors hover:border-primary/60"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={n.blobUrl} alt={n.caption || n.slug} className="h-full w-full object-cover" />
        </Link>
      ))}
    </div>
  );
}

export function TasteVersus({ alignment, both, aOnly, bOnly }: Props) {
  const [copied, setCopied] = useState(false);
  const [shareUrl, setShareUrl] = useState('');

  useEffect(() => {
    setShareUrl(window.location.href);
  }, []);

  const share = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(shareUrl || window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked -- url is visible in the address bar */
    }
  }, [shareUrl]);

  return (
    <div className="space-y-6 pt-8">
      {/* The score */}
      <section className="rounded-xl border border-primary/40 bg-primary/5 p-6 text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-primary">taste alignment</p>
        <p className="mt-1 font-fungal-lite text-6xl leading-none text-ink-100">{alignment}%</p>
        <p className="mt-2 font-mono text-sm text-ink-300">{label(alignment)}</p>
      </section>

      {/* Shared */}
      {both.length > 0 ? (
        <section className="space-y-2">
          <p className="font-mono text-[10px] uppercase tracking-wider text-ink-500">you&rsquo;d both love</p>
          <Thumbs nodes={both} />
        </section>
      ) : null}

      {/* Divergence */}
      {(aOnly.length > 0 || bOnly.length > 0) ? (
        <section className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <p className="font-mono text-[10px] uppercase tracking-wider text-ink-500">they pull toward</p>
            <Thumbs nodes={aOnly} />
          </div>
          <div className="space-y-2">
            <p className="font-mono text-[10px] uppercase tracking-wider text-ink-500">you pull toward</p>
            <Thumbs nodes={bOnly} />
          </div>
        </section>
      ) : null}

      {/* Actions */}
      <section className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={share}
          className="rounded border border-primary/50 bg-primary/10 px-4 py-1.5 font-mono text-xs text-primary hover:bg-primary/20"
        >
          {copied ? 'copied!' : 'share this match'}
        </button>
        <Link href="/taste" prefetch={false} className="font-mono text-xs text-ink-500 hover:text-ink-300">
          find your own taste
        </Link>
      </section>
    </div>
  );
}
