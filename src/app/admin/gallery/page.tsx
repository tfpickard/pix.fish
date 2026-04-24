'use client';

import { useEffect, useState, useTransition } from 'react';
import {
  DEFAULT_SHUFFLE_PERIOD,
  DEFAULT_SORT,
  SHUFFLE_PERIODS,
  SORT_MODES,
  type ShufflePeriod,
  type SortMode
} from '@/lib/sort/types';

type Defaults = { defaultSort: SortMode; defaultShufflePeriod: ShufflePeriod };

const GROUP_LABELS: Record<string, string> = {
  familiar: 'familiar',
  dispersion: 'dispersion / clustering',
  weird: 'novel / weird'
};

export default function AdminGalleryPage() {
  const [defaults, setDefaults] = useState<Defaults>({
    defaultSort: DEFAULT_SORT,
    defaultShufflePeriod: DEFAULT_SHUFFLE_PERIOD
  });
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [errMsg, setErrMsg] = useState('');
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    fetch('/api/gallery-config')
      .then((r) => r.json())
      .then((d) => {
        setDefaults(d);
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

  const grouped = SORT_MODES.reduce<Record<string, typeof SORT_MODES>>((acc, m) => {
    (acc[m.group] ??= []).push(m);
    return acc;
  }, {});

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="font-display text-2xl text-ink-100">gallery</h1>
        <p className="font-mono text-xs text-ink-500">
          owner defaults for the public gallery -- visitors can override in the sort bar
        </p>
      </div>

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
              {Object.keys(grouped).map((group) => (
                <optgroup key={group} label={GROUP_LABELS[group] ?? group}>
                  {grouped[group]!.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <p className="font-mono text-xs text-ink-500">
              {SORT_MODES.find((m) => m.id === defaults.defaultSort)?.description}
            </p>
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
            <p className="font-mono text-xs text-ink-500">
              seeded sorts reshuffle on each tick; stable sorts re-fetch so new uploads appear
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
