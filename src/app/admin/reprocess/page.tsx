'use client';

import { useEffect, useState, useTransition } from 'react';

type FieldStatus = { field: string; provider: string; model: string; stale: number };
const FIELDS = ['captions', 'descriptions', 'tags', 'embeddings'] as const;

export default function AdminReprocessPage() {
  const [status, setStatus] = useState<FieldStatus[]>([]);
  const [selected, setSelected] = useState<string[]>([...FIELDS]);
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function load() {
    fetch('/api/admin/reprocess')
      .then((r) => r.json())
      .then((data) => {
        setStatus(data.fields ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }

  useEffect(load, []);

  function toggle(f: string) {
    setSelected((p) => (p.includes(f) ? p.filter((x) => x !== f) : [...p, f]));
  }

  function run(scope: 'stale' | 'all') {
    if (selected.length === 0) return;
    if (scope === 'all') {
      const ok = confirm(
        'reprocessing ALL images will re-run every selected field against the current provider and spend API credit. continue?'
      );
      if (!ok) return;
    }
    setResult(null);
    startTransition(async () => {
      const res = await fetch('/api/admin/reprocess', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, fields: selected })
      });
      const data = await res.json();
      if (res.ok) {
        setResult(`enqueued ${data.enqueued} job(s) for ${data.imageCount} image(s)`);
        load();
      } else {
        setResult(`error: ${data.error ?? 'failed'}`);
      }
    });
  }

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="font-display text-3xl text-ink-100">reprocess</h1>
      <p className="font-mono text-xs text-ink-500">
        re-run enrichment against the currently configured provider/model. stale = rows
        whose provider or model differs from current config.
      </p>

      {loading ? (
        <p className="font-mono text-xs text-ink-500">loading...</p>
      ) : (
        <div className="space-y-2">
          {status.map((s) => (
            <label
              key={s.field}
              className="flex items-center gap-3 rounded border border-ink-800 p-3 font-mono text-xs"
            >
              <input
                type="checkbox"
                checked={selected.includes(s.field)}
                onChange={() => toggle(s.field)}
              />
              <span className="w-28 text-ink-300">{s.field}</span>
              <span className="text-ink-500">
                {s.provider}/{s.model}
              </span>
              <span className="ml-auto text-ink-400">{s.stale} stale</span>
            </label>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => run('stale')}
          disabled={isPending || selected.length === 0}
          className="rounded border border-primary/50 bg-primary/10 px-3 py-1.5 font-mono text-xs text-primary hover:bg-primary/20 disabled:opacity-50"
        >
          reprocess stale
        </button>
        <button
          type="button"
          onClick={() => run('all')}
          disabled={isPending || selected.length === 0}
          className="rounded border border-destructive/50 bg-destructive/10 px-3 py-1.5 font-mono text-xs text-destructive hover:bg-destructive/20 disabled:opacity-50"
        >
          reprocess all
        </button>
      </div>

      {result ? <p className="font-mono text-xs text-ink-300">{result}</p> : null}
      <p className="font-mono text-xs text-ink-500">
        jobs are drained by the cron at /api/cron/jobs; monitor progress on the jobs page.
      </p>
    </div>
  );
}
