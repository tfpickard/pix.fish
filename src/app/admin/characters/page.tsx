'use client';

import { useState, useTransition } from 'react';

// Admin controls for the character pipeline. Gating is enforced by the API
// routes (isSiteAdmin); this page just triggers them. Two steps: detect crops
// across all eligible images, then cluster them into the recurring-character
// census. Both run through the job queue, so wait for the cron to drain.
export default function AdminCharactersPage() {
  const [isPending, startTransition] = useTransition();
  const [info, setInfo] = useState<string | null>(null);

  function run(path: string, label: string, body?: Record<string, unknown>) {
    setInfo(null);
    startTransition(async () => {
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {})
        });
        const data = await res.json();
        if (res.ok) {
          setInfo(`${label}: ${JSON.stringify(data)} -- wait for the cron to drain the queue.`);
        } else {
          setInfo(`${label} error: ${data.error ?? 'failed'}`);
        }
      } catch (err) {
        setInfo(`${label} error: ${String(err)}`);
      }
    });
  }

  return (
    <div className="max-w-2xl space-y-5 pt-4">
      <h1 className="font-display text-3xl text-ink-100">characters</h1>
      <p className="font-mono text-xs text-ink-500">
        1) detect + crop figures across every eligible specimen, then 2) cluster the crops into
        recurring characters and file the census. Both enqueue jobs; the per-minute cron drains
        them.
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => run('/api/admin/characters/detect', 'detect')}
          disabled={isPending}
          className="rounded border border-primary/50 bg-primary/10 px-3 py-1.5 font-mono text-xs text-primary hover:bg-primary/20 disabled:opacity-50"
        >
          {isPending ? 'working...' : 'detect all'}
        </button>
        <button
          type="button"
          onClick={() => run('/api/admin/characters/detect', 're-detect', { force: true })}
          disabled={isPending}
          className="rounded border border-ink-700 px-3 py-1.5 font-mono text-xs text-ink-300 hover:text-ink-100 disabled:opacity-50"
        >
          re-detect (force)
        </button>
        <button
          type="button"
          onClick={() => run('/api/admin/characters/cluster', 'cluster')}
          disabled={isPending}
          className="rounded border border-primary/50 bg-primary/10 px-3 py-1.5 font-mono text-xs text-primary hover:bg-primary/20 disabled:opacity-50"
        >
          cluster + census
        </button>
      </div>
      {info ? <p className="break-words font-mono text-xs text-ink-300">{info}</p> : null}
    </div>
  );
}
