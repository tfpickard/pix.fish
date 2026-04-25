'use client';

import { useEffect, useState, useTransition } from 'react';
import {
  DEFAULT_SHUFFLE_PERIOD,
  DEFAULT_SORT,
  SHUFFLE_PERIODS,
  SORT_MODES,
  isShufflePeriod,
  isSortMode,
  type ShufflePeriod,
  type SortMode
} from '@/lib/sort/types';

const DEFAULT_SEARCH_SIM_THRESHOLD = 0.30;

type Defaults = {
  defaultSort: SortMode;
  defaultShufflePeriod: ShufflePeriod;
  searchSimilarityThreshold: number;
};

export default function AdminGalleryPage() {
  const [defaults, setDefaults] = useState<Defaults>({
    defaultSort: DEFAULT_SORT,
    defaultShufflePeriod: DEFAULT_SHUFFLE_PERIOD,
    searchSimilarityThreshold: DEFAULT_SEARCH_SIM_THRESHOLD
  });
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [errMsg, setErrMsg] = useState('');
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    // Validate shape before applying: a malformed payload would make the
    // controlled <select>s drop to their uncontrolled fallback and break
    // subsequent onChange handlers.
    fetch('/api/gallery-config')
      .then(async (r) => (r.ok ? await r.json() : null))
      .then((d: unknown) => {
        if (
          d &&
          typeof d === 'object' &&
          isSortMode((d as Record<string, unknown>).defaultSort as string | null | undefined) &&
          isShufflePeriod(
            (d as Record<string, unknown>).defaultShufflePeriod as string | null | undefined
          )
        ) {
          const obj = d as Record<string, unknown>;
          const rawN = Number(obj.searchSimilarityThreshold);
          setDefaults({
            defaultSort: obj.defaultSort as SortMode,
            defaultShufflePeriod: obj.defaultShufflePeriod as ShufflePeriod,
            searchSimilarityThreshold: Number.isFinite(rawN)
              ? Math.max(0, Math.min(1, rawN))
              : DEFAULT_SEARCH_SIM_THRESHOLD
          });
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  function save(next: Partial<Defaults>) {
    startTransition(async () => {
      const res = await fetch('/api/gallery-config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next)
      });
      if (res.ok) {
        const updated = await res.json();
        setDefaults(updated);
        setStatus('saved');
        setTimeout(() => setStatus('idle'), 2000);
      } else {
        const data = await res.json().catch(() => ({}));
        setErrMsg(data.error ?? 'save failed');
        setStatus('error');
      }
    });
  }

  return (
    <div className="space-y-6">
      <h1 className="font-display text-2xl text-ink-100">gallery</h1>

      {loading ? (
        <p className="font-mono text-xs text-ink-500">loading...</p>
      ) : (
        <div className="space-y-6 rounded-lg border border-ink-800 bg-ink-900/30 p-5">
          <div className="space-y-2">
            <label className="block font-mono text-sm text-ink-100">default sort</label>
            <select
              value={defaults.defaultSort}
              onChange={(e) => save({ defaultSort: e.target.value as SortMode })}
              disabled={isPending}
              className="w-full rounded border border-ink-800 bg-ink-950/60 px-3 py-2 font-mono text-xs text-ink-100 focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/20"
            >
              {SORT_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label className="block font-mono text-sm text-ink-100">default auto-shuffle</label>
            <select
              value={defaults.defaultShufflePeriod}
              onChange={(e) => save({ defaultShufflePeriod: e.target.value as ShufflePeriod })}
              disabled={isPending}
              className="w-full rounded border border-ink-800 bg-ink-950/60 px-3 py-2 font-mono text-xs text-ink-100 focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/20"
            >
              {SHUFFLE_PERIODS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label className="block font-mono text-sm text-ink-100">
              search similarity threshold
            </label>
            <div className="flex items-center gap-4">
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={defaults.searchSimilarityThreshold}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setDefaults((prev) => ({ ...prev, searchSimilarityThreshold: v }));
                }}
                onMouseUp={(e) =>
                  save({ searchSimilarityThreshold: Number((e.target as HTMLInputElement).value) })
                }
                onTouchEnd={(e) =>
                  save({
                    searchSimilarityThreshold: Number((e.target as HTMLInputElement).value)
                  })
                }
                disabled={isPending}
                className="flex-1 accent-primary"
              />
              <span className="w-16 text-right font-mono text-sm text-ink-100">
                {defaults.searchSimilarityThreshold.toFixed(2)}
              </span>
            </div>
            <p className="font-mono text-xs text-ink-500">
              cosine similarity floor for /search results (0 = keep everything, 1 = exact-match
              only). 0.30 is the compiled-in default; raise to surface only tighter matches,
              lower to be more permissive.
            </p>
          </div>

          <div className="flex items-center gap-4 pt-2">
            {isPending && <span className="font-mono text-xs text-ink-500">saving...</span>}
            {status === 'saved' && (
              <span className="font-mono text-xs text-secondary">saved</span>
            )}
            {status === 'error' && (
              <span className="font-mono text-xs text-destructive">{errMsg}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
