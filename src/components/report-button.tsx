'use client';

import { useState, useTransition } from 'react';
import { Flag } from 'lucide-react';

export function ReportButton({
  targetType,
  targetId
}: {
  targetType: 'image' | 'comment';
  targetId: number;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [done, setDone] = useState(false);
  const [isPending, startTransition] = useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetType, targetId, reason: reason.trim() || null })
      });
      setDone(true);
      setOpen(false);
    });
  }

  if (done) {
    return (
      <span className="font-mono text-xs text-ink-500">reported -- thanks</span>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 font-mono text-xs text-ink-700 transition-colors hover:text-ink-400"
        title="report this content"
        aria-label="report"
      >
        <Flag size={11} strokeWidth={1.5} />
        <span>report</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/70 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <form
            onSubmit={submit}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm space-y-4 rounded-lg border border-ink-800 bg-ink-900 p-6 shadow-xl"
          >
            <h3 className="font-mono text-sm text-ink-100">report content</h3>
            <textarea
              placeholder="reason (optional)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={500}
              className="w-full resize-none rounded border border-ink-800 bg-ink-950/60 px-3 py-2 font-mono text-xs text-ink-100 placeholder:text-ink-500 focus:border-primary/40 focus:outline-none"
            />
            <div className="flex items-center gap-4">
              <button
                type="submit"
                disabled={isPending}
                className="font-mono text-xs uppercase tracking-wide text-destructive hover:text-destructive/70 disabled:opacity-40"
              >
                {isPending ? 'sending...' : 'submit report'}
              </button>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="font-mono text-xs text-ink-500 hover:text-ink-100"
              >
                cancel
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
