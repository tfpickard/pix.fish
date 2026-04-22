'use client';

import { useState, useEffect, useTransition } from 'react';
import { Trash2 } from 'lucide-react';

type Entry = { id: number; tag: string; category: string | null; sortOrder: number };

const CATEGORIES = ['medium', 'color', 'style', 'mood', 'content', 'technical', 'other'];

export default function AdminTaxonomyPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [newTag, setNewTag] = useState('');
  const [newCategory, setNewCategory] = useState('other');
  const [filter, setFilter] = useState('');
  const [addStatus, setAddStatus] = useState<'idle' | 'adding' | 'error'>('idle');
  const [addError, setAddError] = useState('');
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    fetch('/api/taxonomy')
      .then((r) => r.json())
      .then((data) => { setEntries(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  function addTag(e: React.FormEvent) {
    e.preventDefault();
    if (!newTag.trim()) return;
    setAddStatus('adding');
    startTransition(async () => {
      const res = await fetch('/api/taxonomy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: newTag.trim(), category: newCategory })
      });
      if (res.ok) {
        const created = await res.json();
        setEntries((prev) => [...prev, created].sort((a, b) => a.tag.localeCompare(b.tag)));
        setNewTag('');
        setAddStatus('idle');
      } else {
        const data = await res.json().catch(() => ({}));
        setAddError(data.error ?? 'add failed');
        setAddStatus('error');
      }
    });
  }

  function deleteEntry(id: number) {
    startTransition(async () => {
      await fetch(`/api/taxonomy/${id}`, { method: 'DELETE' });
      setEntries((prev) => prev.filter((e) => e.id !== id));
    });
  }

  const byCategory = entries
    .filter((e) => !filter || e.tag.includes(filter.toLowerCase()) || (e.category ?? '').includes(filter.toLowerCase()))
    .reduce<Record<string, Entry[]>>((acc, e) => {
      const cat = e.category ?? 'other';
      (acc[cat] ??= []).push(e);
      return acc;
    }, {});

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="font-display text-2xl text-ink-100">taxonomy</h1>
        <p className="font-mono text-xs text-ink-500">
          {entries.length} tags across {Object.keys(byCategory).length} categories
        </p>
      </div>

      {/* Add form */}
      <form onSubmit={addTag} className="flex items-end gap-3">
        <div className="flex-1 space-y-1">
          <label className="font-mono text-xs text-ink-500">new tag</label>
          <input
            value={newTag}
            onChange={(e) => { setNewTag(e.target.value); setAddStatus('idle'); }}
            placeholder="e.g. bokeh"
            className="w-full rounded border border-ink-800 bg-ink-900/40 px-3 py-1.5 font-mono text-xs text-ink-100 placeholder:text-ink-500 focus:border-primary/40 focus:outline-none"
          />
        </div>
        <div className="space-y-1">
          <label className="font-mono text-xs text-ink-500">category</label>
          <select
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            className="rounded border border-ink-800 bg-ink-900/40 px-3 py-1.5 font-mono text-xs text-ink-100 focus:border-primary/40 focus:outline-none"
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>
        <button
          type="submit"
          disabled={isPending || !newTag.trim()}
          className="font-mono text-xs uppercase tracking-wide text-primary hover:text-primary/70 disabled:opacity-40"
        >
          {addStatus === 'adding' ? 'adding...' : 'add'}
        </button>
      </form>
      {addStatus === 'error' && (
        <p className="font-mono text-xs text-destructive">{addError}</p>
      )}

      {/* Filter */}
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="filter tags..."
        className="w-full max-w-xs rounded border border-ink-800 bg-ink-950/40 px-3 py-1.5 font-mono text-xs text-ink-100 placeholder:text-ink-500 focus:border-primary/40 focus:outline-none"
      />

      {loading ? (
        <p className="font-mono text-xs text-ink-500">loading...</p>
      ) : (
        <div className="space-y-5">
          {Object.entries(byCategory).sort(([a], [b]) => a.localeCompare(b)).map(([cat, tags]) => (
            <div key={cat} className="space-y-2">
              <h2 className="font-mono text-xs uppercase tracking-wider text-ink-500">{cat}</h2>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((e) => (
                  <span
                    key={e.id}
                    className="group flex items-center gap-1 rounded-full border border-ink-800 bg-ink-900/30 px-2.5 py-0.5 font-mono text-xs text-ink-300"
                  >
                    {e.tag}
                    <button
                      type="button"
                      onClick={() => deleteEntry(e.id)}
                      disabled={isPending}
                      className="ml-0.5 text-ink-600 opacity-0 transition-opacity group-hover:opacity-100 hover:text-destructive"
                      aria-label={`delete ${e.tag}`}
                    >
                      <Trash2 size={10} />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
