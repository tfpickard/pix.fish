'use client';

import { useEffect, useState, useTransition } from 'react';

type Row = { id: number; field: string; provider: string; model: string; updatedAt: string };

const FIELDS = ['captions', 'descriptions', 'tags', 'embeddings'] as const;
const PROVIDERS = ['anthropic', 'openai'] as const;

export default function AdminAiPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<Record<string, { provider: string; model: string }>>({});
  const [isPending, startTransition] = useTransition();

  function load() {
    fetch('/api/admin/ai-config')
      .then((r) => r.json())
      .then((data) => {
        setRows(data.rows ?? []);
        const d: Record<string, { provider: string; model: string }> = {};
        for (const r of data.rows ?? []) d[r.field] = { provider: r.provider, model: r.model };
        setDraft(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }

  useEffect(load, []);

  function save(field: string) {
    const d = draft[field];
    if (!d) return;
    startTransition(async () => {
      await fetch('/api/admin/ai-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, provider: d.provider, model: d.model })
      });
      load();
    });
  }

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="font-display text-3xl text-ink-100">ai config</h1>
      <p className="font-mono text-xs text-ink-500">
        per-field routing. changes take effect on the next request; reprocess existing
        rows from /admin/reprocess.
      </p>
      {loading ? (
        <p className="font-mono text-xs text-ink-500">loading...</p>
      ) : (
        <div className="space-y-3">
          {FIELDS.map((f) => {
            const d = draft[f] ?? { provider: 'anthropic', model: '' };
            return (
              <div key={f} className="flex items-center gap-2 rounded border border-ink-800 p-3">
                <span className="w-28 font-mono text-xs text-ink-300">{f}</span>
                <select
                  value={d.provider}
                  onChange={(e) =>
                    setDraft((p) => ({ ...p, [f]: { ...d, provider: e.target.value } }))
                  }
                  className="rounded border border-ink-800 bg-ink-950 px-2 py-1 font-mono text-xs text-ink-100"
                >
                  {PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={d.model}
                  onChange={(e) =>
                    setDraft((p) => ({ ...p, [f]: { ...d, model: e.target.value } }))
                  }
                  className="flex-1 rounded border border-ink-800 bg-ink-950 px-2 py-1 font-mono text-xs text-ink-100"
                />
                <button
                  type="button"
                  onClick={() => save(f)}
                  disabled={isPending}
                  className="rounded border border-primary/50 bg-primary/10 px-3 py-1 font-mono text-xs text-primary hover:bg-primary/20 disabled:opacity-50"
                >
                  save
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
