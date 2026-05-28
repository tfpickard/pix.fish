'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import type { ImageWithRelations } from '@/lib/db/queries/images';

export type SourceImage = {
  id: number;
  slug: string;
  blobUrl: string;
  caption: string | null;
  hasEmbedding: boolean;
};

type Mode = 'breed' | 'depart' | 'antibreed' | 'subtract';

type BreedVariants = { variant1: string; variant2: string; variant3: string };
type BreedTag = { tag: string; source: 'taxonomy' | 'freeform'; confidence?: number };

type BreedResponse = {
  mode: Mode;
  variants: BreedVariants;
  tags: BreedTag[];
  neighbors: ImageWithRelations[];
  contextNeighbors: ImageWithRelations[];
  provenance: {
    textProvider: string;
    textModel: string;
    embedProvider: string | null;
    embedModel: string | null;
  };
};

const MAX_SOURCES = 8;

// Per-mode metadata: display label, button styling, what to call the
// context-neighbor strip in the result, and a one-line hint shown next to
// the button bar when the mode would be the next action.
const MODE_META: Record<Mode, {
  label: string;
  hint: string;
  contextTitle: string;
  contextSubtitle: string;
}> = {
  breed: {
    label: 'breed',
    hint: 'centroid + nearest as avoid-list. spiritual successor to all selected.',
    contextTitle: 'centroid avoid-list',
    contextSubtitle: 'we told the model not to look like these'
  },
  depart: {
    label: 'depart',
    hint: 'centroid + nearest as anti-prompt. deliberate departure from the selection.',
    contextTitle: 'departure references',
    contextSubtitle: "what the model was told to NOT be"
  },
  antibreed: {
    label: 'anti-breed',
    hint: 'centroid + FARTHEST existing as positive references. live in the far territory.',
    contextTitle: 'far-territory references',
    contextSubtitle: "existing images farthest from the selection's centroid"
  },
  subtract: {
    label: 'subtract',
    hint: 'first selected is the anchor; remaining are subtracted. anchor - mean(subtracts).',
    contextTitle: 'analogy neighborhood',
    contextSubtitle: 'existing images nearest to (anchor - subtracts) in embedding space'
  }
};

export function BreedClient({ sources }: { sources: SourceImage[] }) {
  const [selected, setSelected] = useState<number[]>([]);
  const [result, setResult] = useState<BreedResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Explicit submitting flag. useTransition was tempting here but its
  // isPending flips to false after the first await inside the transition
  // callback, so a double-click on a button (or clicking reroll mid-flight)
  // could fire concurrent /api/admin/breed calls -- each one paid for a
  // separate LLM + embedding round-trip on the same selection. Plain state
  // flagged before the request and cleared in finally is both simpler and
  // actually correct for awaited work.
  const [submitting, setSubmitting] = useState(false);
  const [lastMode, setLastMode] = useState<Mode | null>(null);
  const [hoverMode, setHoverMode] = useState<Mode | null>(null);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const selectedWithEmbeddings = useMemo(
    () => selected.filter((id) => sources.find((s) => s.id === id)?.hasEmbedding).length,
    [selected, sources]
  );
  const canRun = selectedWithEmbeddings >= 2 && !submitting;

  const toggle = useCallback((id: number) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= MAX_SOURCES) return prev;
      return [...prev, id];
    });
  }, []);

  const clear = useCallback(() => setSelected([]), []);

  const run = useCallback(
    async (mode: Mode) => {
      // Guard against a double-click that wins the disabled-check race:
      // canRun is checked when the button renders, but a tap that lands
      // between the click and the React commit cycle can still fire. The
      // submitting flag is the canonical gate.
      if (selected.length < 2 || submitting) return;
      setError(null);
      setLastMode(mode);
      setSubmitting(true);
      try {
        const res = await fetch('/api/admin/breed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode, imageIds: selected })
        });
        const data = await res.json();
        if (!res.ok) {
          setError(typeof data?.error === 'string' ? data.error : `${mode} failed`);
          return;
        }
        setResult(data as BreedResponse);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'network error');
      } finally {
        setSubmitting(false);
      }
    },
    [selected, submitting]
  );

  const reroll = useCallback(() => {
    if (lastMode) run(lastMode);
  }, [lastMode, run]);

  const activeHint = hoverMode ?? lastMode;

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
            const order = isSelected ? selected.indexOf(img.id) : -1;
            // In subtract mode, the first selection is the anchor (label
            // "A") and the rest are subtracts (label "-1", "-2", ...). Other
            // modes just show the selection order number.
            const isSubtractContext = hoverMode === 'subtract' || lastMode === 'subtract';
            const badge =
              isSelected && isSubtractContext
                ? order === 0
                  ? 'A'
                  : `-${order}`
                : isSelected
                  ? String(order + 1)
                  : null;
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
                {badge ? (
                  <span className="absolute right-1 top-1 rounded bg-primary/90 px-1.5 py-0.5 font-mono text-[10px] text-bg">
                    {badge}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </section>

      <div className="sticky bottom-4 z-10 space-y-2 rounded border border-ink-800 bg-bg/95 p-3 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2">
          {(Object.keys(MODE_META) as Mode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => run(mode)}
              onMouseEnter={() => setHoverMode(mode)}
              onMouseLeave={() => setHoverMode(null)}
              onFocus={() => setHoverMode(mode)}
              onBlur={() => setHoverMode(null)}
              disabled={!canRun}
              title={MODE_META[mode].hint}
              className={[
                'rounded border px-3 py-1.5 font-mono text-xs disabled:cursor-not-allowed disabled:opacity-40',
                lastMode === mode && result
                  ? 'border-primary/70 bg-primary/15 text-primary'
                  : 'border-primary/50 bg-primary/10 text-primary hover:bg-primary/20'
              ].join(' ')}
            >
              {submitting && lastMode === mode
                ? `${MODE_META[mode].label}...`
                : `${MODE_META[mode].label} (${selectedWithEmbeddings})`}
            </button>
          ))}
          {result ? (
            <button
              type="button"
              onClick={reroll}
              disabled={!canRun}
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
        {activeHint ? (
          <p className="font-mono text-[10px] text-ink-500/80">{MODE_META[activeHint].hint}</p>
        ) : null}
      </div>

      {result ? <ResultPanel result={result} /> : null}
    </div>
  );
}

function ResultPanel({ result }: { result: BreedResponse }) {
  const meta = MODE_META[result.mode];
  return (
    <section className="space-y-6 rounded border border-ink-800 p-5">
      <div className="space-y-1">
        <p className="font-mono text-[10px] uppercase tracking-wider text-primary">
          {meta.label}
        </p>
      </div>
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
        title={meta.contextTitle}
        subtitle={meta.contextSubtitle}
        images={result.contextNeighbors}
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
