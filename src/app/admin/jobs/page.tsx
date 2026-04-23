'use client';

import { useEffect, useState } from 'react';

type Counts = { type: string; status: string; count: number };
type Row = {
  id: number;
  type: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
  createdAt: string;
};

function statusClass(s: string): string {
  if (s === 'done') return 'text-ink-400';
  if (s === 'failed') return 'text-destructive';
  if (s === 'processing') return 'text-secondary';
  return 'text-ink-300';
}

export default function AdminJobsPage() {
  const [counts, setCounts] = useState<Counts[]>([]);
  const [recent, setRecent] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  function load() {
    fetch('/api/admin/jobs')
      .then((r) => r.json())
      .then((data) => {
        setCounts(data.counts ?? []);
        setRecent(data.recent ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }

  useEffect(() => {
    load();
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, []);

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="font-display text-3xl text-ink-100">jobs</h1>
      <p className="font-mono text-xs text-ink-500">
        background queue. auto-refreshes every 5s.
      </p>

      <section>
        <h2 className="font-mono text-xs text-ink-500 mb-2">summary</h2>
        {loading ? (
          <p className="font-mono text-xs text-ink-500">loading...</p>
        ) : counts.length === 0 ? (
          <p className="font-mono text-xs text-ink-500">no jobs yet</p>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {counts.map((c) => (
              <div key={`${c.type}-${c.status}`} className="rounded border border-ink-800 p-2 font-mono text-xs">
                <p className="text-ink-300">{c.type}</p>
                <p className={statusClass(c.status)}>
                  {c.status}: {c.count}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="font-mono text-xs text-ink-500 mb-2">recent</h2>
        <div className="space-y-1">
          {recent.map((r) => (
            <div key={r.id} className="rounded border border-ink-800 p-2 font-mono text-xs">
              <div className="flex items-center gap-3">
                <span className="text-ink-500">#{r.id}</span>
                <span className="text-ink-300">{r.type}</span>
                <span className={statusClass(r.status)}>{r.status}</span>
                <span className="text-ink-500">
                  {r.attempts}/{r.maxAttempts}
                </span>
                <span className="ml-auto text-ink-500">{new Date(r.createdAt).toLocaleString()}</span>
              </div>
              {r.lastError ? <p className="mt-1 text-destructive">{r.lastError}</p> : null}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
