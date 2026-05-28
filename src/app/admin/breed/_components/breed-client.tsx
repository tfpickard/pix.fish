'use client';

import { useCallback, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import type { ImageWithRelations } from '@/lib/db/queries/images';

export type SourceImage = {
  id: number;
  slug: string;
  blobUrl: string;
  caption: string | null;
  hasEmbedding: boolean;
};

type BreedVariants = { variant1: string; variant2: string; variant3: string };
type BreedTag = { tag: string; source: 'taxonomy' | 'freeform'; confidence?: number };

type BreedResponse = {
  variants: BreedVariants;
  tags: BreedTag[];
  neighbors: ImageWithRelations[];
  centroidNeighbors: ImageWithRelations[];
  provenance: {
    textProvider: string;
    textModel: string;
    embedProvider: string | null;
    embedModel: string | null;
  };
};

const MAX_SOURCES = 8;

export function BreedClient({ sources }: { sources: SourceImage[] }) {
  const [selected, setSelected] = useState<number[]>([]);
  const [result, setResult] = useState<BreedResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const selectedWithEmbeddings = useMemo(
    () => selected.filter((id) => sources.find((s) => s.id === id)?.hasEmbedding).length,
    [selected, sources]
  );
  const canBreed = selectedWithEmbeddings >= 2 && !isPending;

  const toggle = useCallback((id: number) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_SOURCES) return prev;
      return [...prev, id];
    });
  }, []);

  const clear = useCallback(() => setSelected([]), []);

  const run = useCallback(() => {
    if (selected.length < 2) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/breed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageIds: selected })
        });
        const data = await res.json();
        if (!res.ok) {
          setError(typeof data?.error === 'string' ? data.error : 'breed failed');
          return;
        }
        setResult(data as BreedResponse);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'network error');
      }
    });
  }, [selected]);

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex items-center justify-between font-mono text-xs">
          <span className="text-ink-500">
            {selected.length} selected
            {selected.length > 0 && selectedWithEmbeddings < selected.length ? (
              <span className="text-amber-400">
                {' '}
                ({selected.length - selectedWithEmbeddings} unembedded, will not contribute)
              </span>
            ) : null}
          </span>
          {selected.length > 0 ? (
            <button
              type="button"
              onClick={clear}
              className="text-ink-500 underline-offset-2 hover:text-ink-300 hover:underline"
            >
              clear
            </button>
          ) : null}
        </div>

        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8">
          {sources.map((img) => {
            const isSelected = selectedSet.has(img.id);
            return (
              <button
                key={img.id}
                type="button"
                onClick={() => toggle(img.id)}
                title={img.caption ?? img.slug}
                className={[
                  'group relative aspect-square overflow-hidden rounded border transition',
                  isSelected
                    ? 'border-primary ring-2 ring-primary/60'
                    : 'border-ink-800 hover:border-ink-500',
                  !img.hasEmbedding ? 'opacity-50' : ''
                ].join(' ')}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.blobUrl}
                  alt={img.caption ?? img.slug}
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
                {isSelected ? (
                  <span className="absolute right-1 top-1 rounded bg-primary/90 px-1.5 py-0.5 font-mono text-[10px] text-bg">
                    {selected.indexOf(img.id) + 1}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </section>

      <div className="sticky bottom-4 z-10 flex flex-wrap items-center gap-2 rounded border border-ink-800 bg-bg/95 p-3 backdrop-blur">
        <button
          type="button"
          onClick={run}
          disabled={!canBreed}
          className="rounded border border-primary/50 bg-primary/10 px-3 py-1.5 font-mono text-xs text-primary hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {isPending ? 'breeding...' : `breed (${selectedWithEmbeddings})`}
        </button>
        {result ? (
          <button
            type="button"
            onClick={run}
            disabled={!canBreed}
            className="rounded border border-ink-700 px-3 py-1.5 font-mono text-xs text-ink-300 hover:border-ink-500 disabled:opacity-40"
          >
            reroll
          </button>
        ) : null}
        {error ? <span className="font-mono text-xs text-destructive">{error}</span> : null}
        {result ? (
          <span className="ml-auto font-mono text-[10px] text-ink-500">
            {result.provenance.textProvider}/{result.provenance.textModel}
            {result.provenance.embedModel
              ? ` · ${result.provenance.embedProvider}/${result.provenance.embedModel}`
              : ' · no embedding'}
          </span>
        ) : null}
      </div>

      {result ? <ResultPanel result={result} /> : null}
    </div>
  );
}

function ResultPanel({ result }: { result: BreedResponse }) {
  return (
    <section className="space-y-6 rounded border border-ink-800 p-5">
      <div className="space-y-4">
        <Variant label="literal" tone="text-ink-100" text={result.variants.variant1} />
        <Variant label="poetic" tone="font-display text-ink-100" text={result.variants.variant2} />
        <Variant label="scene" tone="text-ink-200" text={result.variants.variant3} />
      </div>

      {result.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {result.tags.map((t) => (
            <span
              key={t.tag}
              className={[
                'rounded px-1.5 py-0.5 font-mono text-[10px]',
                t.source === 'taxonomy'
                  ? 'bg-primary/10 text-primary'
                  : 'bg-ink-800 text-ink-300'
              ].join(' ')}
            >
              {t.tag}
            </span>
          ))}
        </div>
      ) : null}

      <NeighborStrip
        title="closest existing images to this phantom"
        subtitle="where this idea lives in your library"
        images={result.neighbors}
      />
      <NeighborStrip
        title="centroid avoid-list"
        subtitle="we told the model not to look like these"
        images={result.centroidNeighbors}
      />
    </section>
  );
}

function Variant({ label, tone, text }: { label: string; tone: string; text: string }) {
  if (!text) return null;
  return (
    <div className="space-y-1">
      <p className="font-mono text-[10px] uppercase tracking-wider text-ink-500">{label}</p>
      <p className={`text-lg ${tone}`}>{text}</p>
    </div>
  );
}

function NeighborStrip({
  title,
  subtitle,
  images
}: {
  title: string;
  subtitle: string;
  images: ImageWithRelations[];
}) {
  if (images.length === 0) return null;
  return (
    <div className="space-y-2">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-wider text-ink-500">{title}</p>
        <p className="font-mono text-[10px] text-ink-500/70">{subtitle}</p>
      </div>
      <div className="flex gap-2 overflow-x-auto pb-2">
        {images.map((img) => {
          const cap = img.captions[0]?.text ?? img.slug;
          return (
            <Link
              key={img.id}
              href={`/${img.slug}`}
              className="block shrink-0"
              title={cap}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={img.blobUrl}
                alt={cap}
                loading="lazy"
                className="h-24 w-24 rounded border border-ink-800 object-cover transition hover:border-ink-500"
              />
            </Link>
          );
        })}
      </div>
    </div>
  );
}
