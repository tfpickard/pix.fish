'use client';

import { useEffect, useState, useTransition } from 'react';
import { Pencil, Check, X } from 'lucide-react';

type Props = {
  slug: string;
  initialTitle: string;
  // Server-side hint: true when the viewer is a signed-in shelf owner.
  // For anonymous shelves this is always false (the server can't see
  // localStorage); we lift it to true on hydration if the visitor's
  // pix_shelf_slug matches and the rename API accepts the fingerprint.
  canEditFromServer: boolean;
  count: number;
};

const FP_KEY = 'pix_fp';
const SHELF_SLUG_KEY = 'pix_shelf_slug';

function readFingerprint(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(FP_KEY);
  } catch {
    return null;
  }
}

function readSavedShelfSlug(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(SHELF_SLUG_KEY);
  } catch {
    return null;
  }
}

// Shelf header with inline rename for the owner. The viewer-vs-owner
// distinction is decided server-side for signed-in users and on the
// client (via localStorage match) for anonymous users -- the server
// can't read the visitor's fingerprint until the request body carries
// it, so anonymous owners get the rename affordance after hydration.
export function ShelfHeader({ slug, initialTitle, canEditFromServer, count }: Props) {
  const [title, setTitle] = useState(initialTitle);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initialTitle);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [canEdit, setCanEdit] = useState(canEditFromServer);

  useEffect(() => {
    if (canEditFromServer) {
      setCanEdit(true);
      return;
    }
    // Anonymous-owner heuristic: their localStorage holds this exact
    // shelf slug. Server-side PATCH still validates the fingerprint, so
    // a malicious sibling tab can't get past auth even if they set the
    // slug -- this is purely about *showing* the affordance.
    if (readSavedShelfSlug() === slug) setCanEdit(true);
  }, [slug, canEditFromServer]);

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
        body: JSON.stringify({ title: next, fingerprint: readFingerprint() })
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
      {editing && canEdit ? (
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
