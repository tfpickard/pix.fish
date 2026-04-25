'use client';

import { useState, useTransition } from 'react';
import { Pencil, Check, X } from 'lucide-react';

type Props = {
  slug: string;
  initialTitle: string;
  canEdit: boolean;
  count: number;
};

// Shelf header with inline rename for the owner. The viewer-vs-owner
// distinction is decided server-side in the page component (compares
// ownerHash to the requester's hash); this component just renders the
// pencil affordance when canEdit is true.
export function ShelfHeader({ slug, initialTitle, canEdit, count }: Props) {
  const [title, setTitle] = useState(initialTitle);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initialTitle);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save() {
    setError(null);
    const next = draft.trim();
    if (next.length === 0 || next === title) {
      setEditing(false);
      return;
    }
    start(async () => {
      const res = await fetch(`/api/collections/${encodeURIComponent(slug)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: next })
      });
      if (res.ok) {
        setTitle(next);
        setEditing(false);
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? 'rename failed');
      }
    });
  }

  function cancel() {
    setDraft(title);
    setEditing(false);
    setError(null);
  }

  return (
    <header className="mx-auto max-w-2xl space-y-2">
      {editing ? (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') cancel();
            }}
            disabled={pending}
            autoFocus
            maxLength={100}
            className="flex-1 rounded border border-ink-800 bg-ink-950/60 px-3 py-2 font-fungal-lite text-2xl text-ink-100 focus:border-primary/50 focus:outline-none"
          />
          <button
            type="button"
            onClick={save}
            disabled={pending}
            aria-label="save title"
            className="rounded border border-primary/50 bg-primary/10 p-1.5 text-primary hover:bg-primary/20 disabled:opacity-50"
          >
            <Check size={14} />
          </button>
          <button
            type="button"
            onClick={cancel}
            disabled={pending}
            aria-label="cancel"
            className="rounded border border-ink-800 p-1.5 text-ink-400 hover:text-ink-100 disabled:opacity-50"
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <div className="flex items-baseline gap-3">
          <h1 className="font-fungal-lite text-3xl text-ink-100">{title}</h1>
          {canEdit ? (
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label="rename shelf"
              title="rename shelf"
              className="text-ink-500 transition-colors hover:text-ink-200"
            >
              <Pencil size={12} strokeWidth={1.75} />
            </button>
          ) : null}
        </div>
      )}
      <p className="font-mono text-xs text-ink-500">
        /c/{slug} -- {count} {count === 1 ? 'picture' : 'pictures'}
      </p>
      {error ? <p className="font-mono text-xs text-destructive">{error}</p> : null}
    </header>
  );
}
