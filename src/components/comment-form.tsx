'use client';

import { useState, useTransition } from 'react';

type Props = {
  slug: string;
  signedInAs?: { handle: string };
  onPosted?: () => void;
};

export function CommentForm({ slug, signedInAs, onPosted }: Props) {
  const [body, setBody] = useState('');
  const [authorName, setAuthorName] = useState('');
  const [website, setWebsite] = useState(''); // honeypot -- bots fill this via onChange
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [responseStatus, setResponseStatus] = useState<'pending' | 'approved' | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [isPending, startTransition] = useTransition();

  const isUser = !!signedInAs;

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
            // Signed-in users: the server ignores authorName and uses
            // their handle. We still send null so the field is explicit.
            authorName: isUser ? null : authorName.trim() || null,
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
        const data = await res.json().catch(() => ({}));
        setBody('');
        setAuthorName('');
        setStatus('success');
        setResponseStatus(data?.status === 'approved' ? 'approved' : 'pending');
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

      {isUser ? (
        <p className="font-mono text-xs text-ink-500">
          posting as <span className="text-ink-100">@{signedInAs!.handle}</span>
        </p>
      ) : (
        <>
          <input
            type="text"
            placeholder="name (optional)"
            value={authorName}
            onChange={(e) => setAuthorName(e.target.value)}
            maxLength={80}
            className="w-full rounded border border-ink-800 bg-ink-900/40 px-3 py-2 font-mono text-xs text-ink-100 placeholder:text-ink-500 focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/20"
          />
          <p className="font-mono text-[10px] text-ink-500">
            posting as guest -- your approximate location (city only) will be shown next to your comment.
          </p>
        </>
      )}

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
          {responseStatus === 'approved' ? 'posted' : 'posted -- awaiting moderation'}
        </p>
      )}
      {status === 'error' && (
        <p className="font-mono text-xs text-destructive">{errorMsg}</p>
      )}
    </form>
  );
}
