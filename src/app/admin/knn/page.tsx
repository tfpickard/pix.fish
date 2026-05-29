'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';

type Stats = { edgeCount: number; defaultK: number };

// Admin panel for the kNN graph. Shows current edge count and lets a site
// admin enqueue a rebuild job. Modeled on /admin/map (the UMAP panel).
export default function AdminKnnPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [isPending, startTransition] = useTransition();
  const [info, setInfo] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const res = await fetch('/api/admin/knn').then((r) => r.json());
    setStats(res);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, []);

  function rebuild() {
    setInfo(null);
    startTransition(async () => {
      const res = await fetch('/api/admin/knn', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setInfo(`enqueued job #${data.jobId} (k=${data.k}) -- wait for cron to drain, then refresh`);
        // Reload stats after a short delay so the pending job is visible
        // in /admin/jobs without requiring a manual page refresh.
        setTimeout(() => load(), 1500);
      } else {
        setInfo(`error: ${data.error ?? 'failed'}`);
      }
    });
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center gap-3">
        <h1 className="font-display text-3xl text-ink-100">knn graph</h1>
        <button
          type="button"
          onClick={rebuild}
          disabled={isPending || loading}
          className="ml-auto rounded border border-primary/50 bg-primary/10 px-3 py-1.5 font-mono text-xs text-primary hover:bg-primary/20 disabled:opacity-50"
        >
          {isPending ? 'enqueuing...' : 'rebuild'}
        </button>
      </div>

      {info ? (
        <p className="font-mono text-xs text-ink-300">{info}</p>
      ) : null}

      {loading ? (
        <p className="font-mono text-xs text-ink-500">loading...</p>
      ) : stats ? (
        <div className="space-y-2">
          <p className="font-mono text-sm text-ink-200">
            {stats.edgeCount.toLocaleString()} directed edges &nbsp;&middot;&nbsp; default k = {stats.defaultK}
          </p>
          {stats.edgeCount === 0 ? (
            <p className="font-mono text-xs text-amber-400">
              graph is empty -- hit rebuild to run the knn.rebuild job. requires caption embeddings
              to exist (run reprocess or backfill-embeddings first).
            </p>
          ) : null}
        </div>
      ) : (
        <p className="font-mono text-xs text-red-400">failed to load graph stats</p>
      )}

      <div className="space-y-2 rounded border border-ink-800 bg-ink-900/20 p-4">
        <h2 className="font-mono text-xs uppercase tracking-wider text-ink-500">notes</h2>
        <ul className="space-y-1 font-mono text-xs text-ink-400">
          <li>-- rebuild is O(n^2) and runs via the job queue; monitor progress at{' '}
            <Link href="/admin/jobs" className="text-ink-300 underline hover:text-ink-100">/admin/jobs</Link>.
          </li>
          <li>-- for corpora larger than ~5000 images, prefer{' '}
            <code className="text-ink-300">bun scripts/build-knn.ts</code> (no 60s wall).
          </li>
          <li>-- after a rebuild, visit{' '}
            <Link href="/connect" className="text-ink-300 underline hover:text-ink-100">/connect</Link>{' '}
            to find paths between images.
          </li>
        </ul>
      </div>
    </div>
  );
}
