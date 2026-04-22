'use client';

import { useState, useTransition, useEffect } from 'react';
import { useRouter } from 'next/navigation';

type State = 'idle' | 'armed' | 'deleting';

export function ImageActions({ slug }: { slug: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>('idle');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Auto-disarm the confirmation step after 4 seconds of inactivity
  useEffect(() => {
    if (state !== 'armed') return;
    const t = setTimeout(() => setState('idle'), 4000);
    return () => clearTimeout(t);
  }, [state]);

  function arm() {
    setError(null);
    setState('armed');
  }

  function disarm() {
    setState('idle');
  }

  function confirmDelete() {
    setState('deleting');
    startTransition(async () => {
      const res = await fetch(`/api/images/${encodeURIComponent(slug)}`, { method: 'DELETE' });
      if (res.status === 204) {
        router.push('/');
        router.refresh();
        return;
      }
      const msg = await res
        .json()
        .then((b) => {
          if (typeof b?.error === 'string') {
            return b.error === 'forbidden' ? 'sign in as owner to delete' : b.error;
          }
          return `delete failed (${res.status})`;
        })
        .catch(() => `delete failed (${res.status})`);
      setError(msg);
      setState('idle');
    });
  }

  return (
    <div className="flex flex-col items-center gap-2 border-t border-ink-800 pt-4">
      {state === 'idle' && (
        <button
          type="button"
          onClick={arm}
          className="font-mono text-xs uppercase tracking-wide text-ink-500 transition-colors hover:text-destructive"
        >
          delete image
        </button>
      )}

      {state === 'armed' && (
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-ink-400">delete forever?</span>
          <button
            type="button"
            onClick={confirmDelete}
            className="font-mono text-xs uppercase tracking-wide text-destructive transition-colors hover:text-destructive/80"
          >
            yes, delete
          </button>
          <button
            type="button"
            onClick={disarm}
            className="font-mono text-xs text-ink-500 transition-colors hover:text-ink-100"
          >
            cancel
          </button>
        </div>
      )}

      {(state === 'deleting' || isPending) && (
        <span className="font-mono text-xs text-ink-500">deleting...</span>
      )}

      {error ? <p className="font-mono text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
