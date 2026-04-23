'use client';

import { useEffect, useState, useTransition } from 'react';
import { Sparkles } from 'lucide-react';

type Row = {
  id: number;
  key: string;
  label: string;
  content: string;
  sortOrder: number;
  updatedAt: string;
};

function FieldCard({ row, onSaved }: { row: Row; onSaved: (r: Row) => void }) {
  const [content, setContent] = useState(row.content);
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const [saving, startSave] = useTransition();
  const [genning, startGen] = useTransition();

  function save() {
    setError('');
    startSave(async () => {
      const res = await fetch(`/api/admin/about/${encodeURIComponent(row.key)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });
      if (res.ok) {
        const data = await res.json();
        onSaved(data.row);
        setStatus('saved');
        setTimeout(() => setStatus('idle'), 1500);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? 'save failed');
        setStatus('error');
      }
    });
  }

  function generate() {
    setError('');
    startGen(async () => {
      const res = await fetch(`/api/admin/about/${encodeURIComponent(row.key)}/generate`, {
        method: 'POST'
      });
      if (res.ok) {
        const data = await res.json();
        setContent(data.row.content);
        onSaved(data.row);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? 'generate failed');
      }
    });
  }

  return (
    <div className="space-y-2 rounded-lg border border-ink-800 p-4">
      <div className="flex items-center gap-3">
        <h2 className="font-mono text-sm text-ink-100">{row.label}</h2>
        <span className="font-mono text-xs text-ink-500">{row.key}</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={generate}
            disabled={genning || saving}
            className="flex items-center gap-1 rounded border border-secondary/50 bg-secondary/10 px-2 py-1 font-mono text-xs text-secondary hover:bg-secondary/20 disabled:opacity-50"
            title="let the LLM compose a weird semi-biographical draft"
          >
            <Sparkles size={12} />
            {genning ? 'generating...' : 'generate'}
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving || genning}
            className="rounded border border-primary/50 bg-primary/10 px-2 py-1 font-mono text-xs text-primary hover:bg-primary/20 disabled:opacity-50"
          >
            {saving ? 'saving...' : 'save'}
          </button>
        </div>
      </div>
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={6}
        className="w-full rounded border border-ink-800 bg-ink-950 px-3 py-2 font-mono text-sm text-ink-100 focus:border-primary/50 focus:outline-none"
      />
      {error ? <p className="font-mono text-xs text-destructive">{error}</p> : null}
      {status === 'saved' ? <p className="font-mono text-xs text-ink-400">saved</p> : null}
    </div>
  );
}

export default function AdminAboutPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  function load() {
    fetch('/api/admin/about')
      .then((r) => r.json())
      .then((data) => {
        setRows(data.rows ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }

  useEffect(load, []);

  function onSaved(updated: Row) {
    setRows((prev) => prev.map((r) => (r.key === updated.key ? updated : r)));
  }

  return (
    <div className="max-w-3xl space-y-6">
      <header className="space-y-1">
        <h1 className="font-display text-3xl text-ink-100">about</h1>
        <p className="font-mono text-xs text-ink-500">
          fields render publicly at /about in sort order. hit generate to draft bizarre
          semi-biographical copy; save persists your edits.
        </p>
      </header>
      {loading ? (
        <p className="font-mono text-xs text-ink-500">loading...</p>
      ) : rows.length === 0 ? (
        <p className="font-mono text-xs text-ink-500">no fields seeded yet -- run bun run db:seed</p>
      ) : (
        rows.map((r) => <FieldCard key={r.id} row={r} onSaved={onSaved} />)
      )}
    </div>
  );
}
