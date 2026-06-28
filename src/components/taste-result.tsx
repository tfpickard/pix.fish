'use client';

// The taste result -- a shareable aesthetic "card". The current URL encodes the
// picks, so sharing the link reproduces the exact result server-side. Renders
// only NSFW-gated matches (computed on the server), plus the tag signature and
// dominant palette aggregated over those matches.

import { useCallback, useState } from 'react';
import Link from 'next/link';
import type { PathNode } from '@/lib/knn-path-types';

type Props = {
  archetype: string;
  signature: string[];
  palette: string[];
  matches: PathNode[];
  // The visitor's own picks and rejects -- used to mint a "challenge a friend"
  // link that carries BOTH (so the comparison's taste vectors match the solo
  // result's, which also factors in what you passed on).
  picked: number[];
  skipped: number[];
};

function detailUrl(node: PathNode): string {
  return node.handle ? `/u/${node.handle}/${node.slug}` : `/${node.slug}`;
}

function hex(c: string): string {
  return c.startsWith('#') ? c : `#${c}`;
}

export function TasteResult({ archetype, signature, palette, matches, picked, skipped }: Props) {
  const [copied, setCopied] = useState<'' | 'share' | 'challenge'>('');
  const [failedText, setFailedText] = useState('');

  // Build the links from window.location at click time (handlers only run on the
  // client, post-hydration), so a copied URL always matches the real
  // environment (preview, self-host) -- never a stale hardcoded origin.
  const copy = useCallback(async (text: string, which: 'share' | 'challenge') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setFailedText('');
      window.setTimeout(() => setCopied(''), 1800);
    } catch {
      setFailedText(text);
    }
  }, []);

  const share = useCallback(() => copy(window.location.href, 'share'), [copy]);
  const challenge = useCallback(
    () => copy(`${window.location.origin}/taste?vs=${picked.join(',')}&vsk=${skipped.join(',')}`, 'challenge'),
    [copy, picked, skipped]
  );

  return (
    <div className="space-y-6 pt-8">
      {/* The card */}
      <section className="overflow-hidden rounded-xl border border-primary/40 bg-primary/5">
        <div className="space-y-3 p-5">
          <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-primary">your aesthetic</p>
          <h1 className="font-fungal-lite text-3xl leading-tight text-ink-100 md:text-4xl">
            {archetype}
          </h1>

          {palette.length > 0 ? (
            <div className="flex items-center gap-1.5 pt-1">
              {palette.map((c) => (
                <span
                  key={c}
                  title={hex(c)}
                  className="h-5 w-5 rounded-full border border-ink-700/60"
                  style={{ backgroundColor: hex(c) }}
                />
              ))}
            </div>
          ) : null}

          {signature.length > 0 ? (
            <div className="flex flex-wrap gap-1 pt-1">
              {signature.map((t) => (
                <Link key={t} href={`/search?q=${encodeURIComponent(t)}`} prefetch={false} className="chip">
                  {t}
                </Link>
              ))}
            </div>
          ) : null}
        </div>

        {/* Matches: the gallery, re-ranked as you */}
        <div className="border-t border-primary/20 bg-ink-950/40 p-4">
          <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-500">
            the gallery, as you
          </p>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6">
            {matches.map((node) => (
              <Link
                key={node.imageId}
                href={detailUrl(node)}
                title={node.caption || node.slug}
                className="group relative aspect-square overflow-hidden rounded-md border border-ink-800/80 bg-ink-950 transition-colors hover:border-primary/60"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={node.blobUrl}
                  alt={node.caption || node.slug}
                  className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.04]"
                />
              </Link>
            ))}
          </div>
        </div>
      </section>

      {/* Actions */}
      <section className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={share}
          className="rounded border border-primary/50 bg-primary/10 px-4 py-1.5 font-mono text-xs text-primary hover:bg-primary/20"
        >
          {copied === 'share' ? 'copied!' : 'share your taste'}
        </button>
        <button
          type="button"
          onClick={challenge}
          className="rounded border border-ink-700 bg-ink-900 px-4 py-1.5 font-mono text-xs text-ink-200 hover:border-primary/50 hover:text-primary"
        >
          {copied === 'challenge' ? 'link copied -- send it!' : 'challenge a friend'}
        </button>
        <Link href="/taste" prefetch={false} className="font-mono text-xs text-ink-500 hover:text-ink-300">
          take it again
        </Link>
      </section>
      <p className="font-mono text-[11px] text-ink-600">
        &ldquo;challenge a friend&rdquo; copies a link -- when they finish, you&rsquo;ll see how aligned your tastes are.
      </p>

      {failedText ? (
        <div className="space-y-1">
          <p className="font-mono text-[10px] text-ink-500">copy didn&rsquo;t work -- select and copy this:</p>
          <textarea
            readOnly
            value={failedText}
            rows={2}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full resize-none rounded border border-ink-700 bg-ink-950 p-2 font-mono text-[11px] text-ink-300"
          />
        </div>
      ) : null}
    </div>
  );
}
