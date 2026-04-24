'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  parseShufflePeriodMs,
  SHUFFLE_PERIODS,
  SORT_META,
  SORT_MODES,
  isShufflePeriod,
  isSortMode,
  type ShufflePeriod,
  type SortMode
} from '@/lib/sort/types';

type Props = {
  ownerDefaults: { defaultSort: SortMode; defaultShufflePeriod: ShufflePeriod };
};

const LS_SORT = 'pix_sort';
const LS_PERIOD = 'pix_shuffle_period';

function readLocalStorage(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocalStorage(key: string, value: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // private-mode / quota -- ignore
  }
}

function mintSeed(): string {
  try {
    return crypto.randomUUID().slice(0, 8);
  } catch {
    return Math.random().toString(36).slice(2, 10);
  }
}

export function SortBar({ ownerDefaults }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const urlSort = searchParams.get('sort');
  const urlSeed = searchParams.get('seed');

  const [effectiveSort, setEffectiveSort] = useState<SortMode>(
    isSortMode(urlSort) ? urlSort : ownerDefaults.defaultSort
  );
  const [effectivePeriod, setEffectivePeriod] = useState<ShufflePeriod>(
    ownerDefaults.defaultShufflePeriod
  );
  const [countdownMs, setCountdownMs] = useState<number | null>(null);

  function buildQuery(sort: SortMode, seed: string | null): string {
    const next = new URLSearchParams();
    for (const [k, v] of searchParams.entries()) {
      if (k === 'sort' || k === 'seed') continue;
      next.append(k, v);
    }
    if (sort !== ownerDefaults.defaultSort) next.set('sort', sort);
    if (seed) next.set('seed', seed);
    return next.toString();
  }

  function navigate(sort: SortMode, seed: string | null) {
    const qs = buildQuery(sort, seed);
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }

  // On mount: hydrate localStorage-driven prefs. If the stored sort differs
  // from the URL and from the owner default, reflect it in the URL so the
  // server re-renders with the visitor's choice.
  useEffect(() => {
    const storedSort = readLocalStorage(LS_SORT);
    const storedPeriod = readLocalStorage(LS_PERIOD);
    if (isShufflePeriod(storedPeriod)) setEffectivePeriod(storedPeriod);

    if (!urlSort && isSortMode(storedSort) && storedSort !== ownerDefaults.defaultSort) {
      setEffectiveSort(storedSort);
      const nextSeed = SORT_META[storedSort].randomSeeded ? mintSeed() : null;
      navigate(storedSort, nextSeed);
    } else if (isSortMode(urlSort)) {
      setEffectiveSort(urlSort);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-shuffle timer. Clears and rebuilds when period or sort changes.
  // Seeded modes mint a new seed per tick; non-seeded modes refresh the
  // server component so new uploads/reactions surface.
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickDeadlineRef = useRef<number | null>(null);

  useEffect(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
    intervalRef.current = null;
    countdownRef.current = null;
    tickDeadlineRef.current = null;
    setCountdownMs(null);

    const periodMs = parseShufflePeriodMs(effectivePeriod);
    if (periodMs === null) return;

    tickDeadlineRef.current = Date.now() + periodMs;
    setCountdownMs(periodMs);

    intervalRef.current = setInterval(() => {
      tickDeadlineRef.current = Date.now() + periodMs;
      setCountdownMs(periodMs);
      const meta = SORT_META[effectiveSort];
      if (meta.randomSeeded) {
        navigate(effectiveSort, mintSeed());
      } else {
        router.refresh();
      }
    }, periodMs);

    countdownRef.current = setInterval(() => {
      if (tickDeadlineRef.current === null) return;
      setCountdownMs(Math.max(0, tickDeadlineRef.current - Date.now()));
    }, 1000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectivePeriod, effectiveSort]);

  function changeSort(next: SortMode) {
    setEffectiveSort(next);
    writeLocalStorage(LS_SORT, next === ownerDefaults.defaultSort ? null : next);
    const seed = SORT_META[next].randomSeeded ? mintSeed() : null;
    navigate(next, seed);
  }

  function changePeriod(next: ShufflePeriod) {
    setEffectivePeriod(next);
    writeLocalStorage(
      LS_PERIOD,
      next === ownerDefaults.defaultShufflePeriod ? null : next
    );
  }

  const sortIsOverride = effectiveSort !== ownerDefaults.defaultSort;
  const periodIsOverride = effectivePeriod !== ownerDefaults.defaultShufflePeriod;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-wrap items-end gap-x-4 gap-y-3 border-b border-ink-800/60 pb-4 font-mono text-xs text-ink-500">
      <div className="flex flex-col gap-1">
        <label className="uppercase tracking-wider text-ink-500" htmlFor="sort-select">
          sort
        </label>
        <div className="flex items-center gap-2">
          <select
            id="sort-select"
            value={effectiveSort}
            onChange={(e) => changeSort(e.target.value as SortMode)}
            className="rounded border border-ink-800 bg-ink-950/60 px-2 py-1 text-ink-100 focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/20"
          >
            {SORT_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
                {m.id === ownerDefaults.defaultSort ? ' (owner)' : ''}
              </option>
            ))}
          </select>
          {sortIsOverride && (
            <button
              type="button"
              onClick={() => changeSort(ownerDefaults.defaultSort)}
              className="text-ink-500 hover:text-ink-100"
              title="reset to owner default"
            >
              reset
            </button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label className="uppercase tracking-wider text-ink-500" htmlFor="shuffle-select">
          auto-shuffle
        </label>
        <div className="flex items-center gap-2">
          <select
            id="shuffle-select"
            value={effectivePeriod}
            onChange={(e) => changePeriod(e.target.value as ShufflePeriod)}
            className="rounded border border-ink-800 bg-ink-950/60 px-2 py-1 text-ink-100 focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/20"
          >
            {SHUFFLE_PERIODS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.id === ownerDefaults.defaultShufflePeriod ? ' (owner)' : ''}
              </option>
            ))}
          </select>
          {periodIsOverride && (
            <button
              type="button"
              onClick={() => changePeriod(ownerDefaults.defaultShufflePeriod)}
              className="text-ink-500 hover:text-ink-100"
              title="reset to owner default"
            >
              reset
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 basis-full text-right md:basis-auto">
        {countdownMs !== null ? (
          <span className="text-ink-500">
            next shuffle in {Math.ceil(countdownMs / 1000)}s
          </span>
        ) : urlSeed ? (
          <span className="text-ink-500">seed: {urlSeed}</span>
        ) : null}
      </div>
    </div>
  );
}
