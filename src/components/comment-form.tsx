'use client';

import { useState, useTransition } from 'react';

export function CommentForm({ slug, onPosted }: { slug: string; onPosted?: () => void }) {
  const [body, setBody] = useState('');
  const [authorName, setAuthorName] = useState('');
  const [website, setWebsite] = useState(''); // honeypot -- bots fill this via onChange
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [isPending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!body.trim()) return;
    setStatus('idle');
    startTransition(async () => {
      try {
        const res = await fetch(`/api/images/${encodeURIComponent(slug)}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            body: body.trim(),
            authorName: authorName.trim() || null,
            website
          })
        });
        if (res.status === 429) {
          setStatus('error');
          setErrorMsg('too many comments -- try again later');
          return;
        }
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setStatus('error');
          setErrorMsg(data.error ?? 'something went wrong');
          return;
        }
        setBody('');
        setAuthorName('');
        setStatus('success');
        onPosted?.();
      } catch {
        setStatus('error');
        setErrorMsg('network error -- please try again');
      }
    });
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      {/* Honeypot -- off-screen, invisible to humans; bots fill it via onChange */}
      <input
        name="website"
        type="text"
        value={website}
        onChange={(e) => setWebsite(e.target.value)}
        tabIndex={-1}
        aria-hidden="true"
        autoComplete="off"
        style={{ position: 'absolute', left: '-9999px', width: '1px', height: '1px' }}
      />

      <input
        type="text"
        placeholder="name (optional)"
        value={authorName}
        onChange={(e) => setAuthorName(e.target.value)}
        maxLength={80}
        className="w-full rounded border border-ink-800 bg-ink-900/40 px-3 py-2 font-mono text-xs text-ink-100 placeholder:text-ink-500 focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/20"
      />

      <textarea
        placeholder="leave a comment..."
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        maxLength={2000}
        required
        className="w-full resize-y rounded border border-ink-800 bg-ink-900/40 px-3 py-2 font-mono text-xs text-ink-100 placeholder:text-ink-500 focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/20"
      />

      <div className="flex items-center justify-between gap-3">
        <button
          type="submit"
          disabled={isPending || !body.trim()}
          className="font-mono text-xs uppercase tracking-wide text-primary transition-colors hover:text-primary/70 disabled:opacity-40"
        >
          {isPending ? 'posting...' : 'post comment'}
        </button>
        <span className="font-mono text-xs text-ink-500">{body.length}/2000</span>
      </div>

      {status === 'success' && (
        <p className="font-mono text-xs text-secondary">
          posted -- awaiting moderation
        </p>
      )}
      {status === 'error' && (
        <p className="font-mono text-xs text-destructive">{errorMsg}</p>
      )}
    </form>
  );
}
