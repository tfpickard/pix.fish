'use client';

import { useState, useEffect, useTransition } from 'react';
import Link from 'next/link';
import { CheckCircle, XCircle, Trash2 } from 'lucide-react';

// Shape mirrors ModerationComment from src/lib/db/queries/comments.ts,
// but with dates serialised to strings as they cross the JSON boundary.
type CommentAuthor =
  | { kind: 'user'; handle: string; displayName: string | null }
  | {
      kind: 'guest';
      name: string | null;
      city: string | null;
      region: string | null;
      country: string | null;
    };

type CommentRow = {
  id: number;
  imageSlug: string;
  body: string;
  status: string;
  createdAt: string;
  author: CommentAuthor;
};

function formatGeo(
  city: string | null,
  region: string | null,
  country: string | null
): string | null {
  if (city && region) return `${city}, ${region}`;
  return city ?? region ?? country ?? null;
}

function formatDate(d: string): string {
  return new Date(d).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

export default function AdminCommentsPage() {
  const [comments, setComments] = useState<CommentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    setLoading(true);
    fetch(`/api/comments?status=${statusFilter}`)
      .then((r) => r.json())
      .then((data) => { setComments(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, [statusFilter]);

  function setStatus(id: number, status: 'approved' | 'rejected') {
    startTransition(async () => {
      const res = await fetch(`/api/comments/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      if (res.ok) setComments((prev) => prev.filter((c) => c.id !== id));
    });
  }

  function deleteComment(id: number) {
    startTransition(async () => {
      await fetch(`/api/comments/${id}`, { method: 'DELETE' });
      setComments((prev) => prev.filter((c) => c.id !== id));
    });
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="font-display text-2xl text-ink-100">comments</h1>
        <p className="font-mono text-xs text-ink-500">moderation queue</p>
      </div>

      <div className="flex gap-4 font-mono text-xs">
        {(['pending', 'approved', 'rejected'] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(s)}
            className={[
              'uppercase tracking-wide transition-colors',
              statusFilter === s ? 'text-primary' : 'text-ink-500 hover:text-ink-100'
            ].join(' ')}
          >
            {s}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="font-mono text-xs text-ink-500">loading...</p>
      ) : comments.length === 0 ? (
        <p className="font-mono text-xs text-ink-500">no {statusFilter} comments</p>
      ) : (
        <div className="divide-y divide-ink-800 rounded-lg border border-ink-800">
          {comments.map((c) => (
            <div key={c.id} className="flex items-start justify-between gap-4 px-4 py-4">
              <div className="min-w-0 space-y-1.5">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-xs">
                  {c.author.kind === 'user' ? (
                    <span className="text-ink-100">
                      <span className="rounded bg-primary/15 px-1 py-0.5 text-[10px] uppercase tracking-wide text-primary">
                        user
                      </span>{' '}
                      @{c.author.handle}
                    </span>
                  ) : (
                    <span className="text-ink-100">
                      <span className="rounded bg-ink-800 px-1 py-0.5 text-[10px] uppercase tracking-wide text-ink-400">
                        guest
                      </span>{' '}
                      {c.author.name || 'anonymous'}
                      {(() => {
                        const geo = formatGeo(
                          c.author.city,
                          c.author.region,
                          c.author.country
                        );
                        return geo ? (
                          <span className="text-ink-500"> · {geo}</span>
                        ) : null;
                      })()}
                    </span>
                  )}
                  <span className="text-ink-500">{formatDate(c.createdAt)}</span>
                  <Link
                    href={`/${c.imageSlug}`}
                    target="_blank"
                    className="max-w-[160px] truncate text-ink-500 transition-colors hover:text-primary"
                  >
                    /{c.imageSlug}
                  </Link>
                </div>
                <p className="text-sm leading-relaxed text-ink-200">{c.body}</p>
              </div>

              <div className="flex shrink-0 items-center gap-2 pt-0.5">
                {c.status === 'pending' && (
                  <>
                    <button
                      type="button"
                      onClick={() => setStatus(c.id, 'approved')}
                      disabled={isPending}
                      title="approve"
                      className="text-secondary transition-colors hover:text-secondary/70 disabled:opacity-40"
                    >
                      <CheckCircle size={16} strokeWidth={1.5} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setStatus(c.id, 'rejected')}
                      disabled={isPending}
                      title="reject"
                      className="text-destructive transition-colors hover:text-destructive/70 disabled:opacity-40"
                    >
                      <XCircle size={16} strokeWidth={1.5} />
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={() => deleteComment(c.id)}
                  disabled={isPending}
                  title="delete permanently"
                  className="text-ink-600 transition-colors hover:text-destructive disabled:opacity-40"
                >
                  <Trash2 size={14} strokeWidth={1.5} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
