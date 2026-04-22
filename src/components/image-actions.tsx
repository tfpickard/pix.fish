'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

export function ImageActions({ slug }: { slug: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function onDelete() {
    if (!confirm(`delete "${slug}"? this cannot be undone.`)) return;
    setError(null);
    startTransition(async () => {
      const res = await fetch(`/api/images/${encodeURIComponent(slug)}`, { method: 'DELETE' });
      if (res.status === 204) {
        router.push('/');
        router.refresh();
        return;
      }
      const msg = await res
        .json()
        .then((b) => (typeof b?.error === 'string' ? b.error : `delete failed (${res.status})`))
        .catch(() => `delete failed (${res.status})`);
      setError(msg);
    });
  }

  return (
    <div className="flex flex-col items-center gap-1.5 border-t border-ink-800 pt-4">
      <button
        type="button"
        onClick={onDelete}
        disabled={isPending}
        className="font-mono text-xs uppercase tracking-wide text-red-400/70 hover:text-red-300 disabled:opacity-50"
      >
        {isPending ? 'deleting...' : 'delete'}
      </button>
      {error ? <p className="font-mono text-xs text-red-400">{error}</p> : null}
    </div>
  );
}
