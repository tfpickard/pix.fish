'use client';

import { useEffect, useState } from 'react';

// feat/hud: dismissible, fixed-position overlay showing the collection
// "temperature" (mean pairwise cosine distance over caption embeddings -- how
// spread out the gallery is in meaning-space). Fixed positioning means it
// never participates in document flow, so there is zero layout shift whether
// it is shown or hidden. Dismissal persists in localStorage so it stays gone
// across navigations until the visitor reopens it.

const DISMISS_KEY = 'pf_hud_dismissed';

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDismissed(value: boolean): void {
  try {
    if (value) window.localStorage.setItem(DISMISS_KEY, '1');
    else window.localStorage.removeItem(DISMISS_KEY);
  } catch {
    // localStorage can be unavailable (private mode); dismissal is then
    // session-only, which is acceptable.
  }
}

export function TemperatureHudShell({
  value,
  previous,
  pointCount,
  computedAt
}: {
  value: number;
  previous: number | null;
  pointCount: number;
  computedAt: string;
}) {
  // Two pieces of state, on purpose:
  //  - `mounted` gates the first client paint so SSR (which can't read
  //    localStorage) and hydration agree -- the server always renders the
  //    collapsed dot, then the client reconciles to the stored preference.
  //  - `dismissed` is the persisted preference, read once after mount.
  const [mounted, setMounted] = useState(false);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    setMounted(true);
    setDismissed(readDismissed());
  }, []);

  function dismiss() {
    setDismissed(true);
    writeDismissed(true);
  }

  function reopen() {
    setDismissed(false);
    writeDismissed(false);
  }

  const delta = previous !== null ? value - previous : null;
  const deltaLabel =
    delta === null
      ? null
      : delta === 0
        ? 'steady'
        : `${delta > 0 ? '+' : ''}${delta.toFixed(3)}`;
  const computed = new Date(computedAt).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });

  // Collapsed affordance: a tiny fixed dot the visitor can click to reopen.
  // Shown pre-mount and whenever dismissed.
  if (!mounted || dismissed) {
    return (
      <button
        type="button"
        onClick={reopen}
        aria-label="show collection temperature"
        className="fixed bottom-4 right-4 z-40 h-7 w-7 rounded-full border border-ink-800/70 bg-ink-950/80 font-mono text-[10px] text-ink-500 backdrop-blur transition-colors hover:text-ink-200"
      >
        T
      </button>
    );
  }

  return (
    <aside
      aria-label="collection temperature"
      className="fixed bottom-4 right-4 z-40 w-56 rounded-lg border border-ink-800/70 bg-ink-950/85 p-3 font-mono text-xs text-ink-300 shadow-lg backdrop-blur"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="uppercase tracking-wider text-ink-500">temperature</span>
        <button
          type="button"
          onClick={dismiss}
          aria-label="dismiss collection temperature"
          className="text-ink-600 transition-colors hover:text-ink-200"
        >
          x
        </button>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl text-ink-100 tabular-nums">{value.toFixed(3)}</span>
        {deltaLabel ? (
          <span className={delta && delta > 0 ? 'text-primary' : 'text-ink-500'}>
            {deltaLabel}
          </span>
        ) : null}
      </div>
      <p className="mt-1 leading-snug text-ink-500">
        mean spread across {pointCount} embedded image{pointCount === 1 ? '' : 's'}. higher
        means a more varied collection.
      </p>
      <p className="mt-1 text-[10px] text-ink-600">computed {computed}</p>
    </aside>
  );
}
