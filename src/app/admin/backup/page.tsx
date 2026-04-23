'use client';

import { useEffect, useRef, useState, useTransition } from 'react';

type Status = {
  status: string;
  blobUrl: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: string | null;
};

export default function AdminBackupPage() {
  const [jobId, setJobId] = useState<number | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [isPending, startTransition] = useTransition();
  const iv = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (iv.current) clearInterval(iv.current);
    },
    []
  );

  function poll(id: number) {
    if (iv.current) clearInterval(iv.current);
    iv.current = setInterval(async () => {
      const res = await fetch(`/api/admin/backup/${id}`);
      if (!res.ok) return;
      const data: Status = await res.json();
      setStatus(data);
      if (data.status === 'done' || data.status === 'failed') {
        if (iv.current) clearInterval(iv.current);
        iv.current = null;
      }
    }, 3000);
  }

  function start() {
    setStatus(null);
    startTransition(async () => {
      const res = await fetch('/api/admin/backup', { method: 'POST' });
      if (!res.ok) return;
      const data = await res.json();
      setJobId(data.jobId);
      poll(data.jobId);
    });
  }

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="font-display text-3xl text-ink-100">backup</h1>
      <p className="font-mono text-xs text-ink-500">
        exports a zip containing db.json + all image blobs to private vercel blob storage.
        api keys and webhook secrets are redacted.
      </p>
      <button
        type="button"
        onClick={start}
        disabled={isPending || (status?.status === 'pending' || status?.status === 'processing')}
        className="rounded border border-primary/50 bg-primary/10 px-3 py-1.5 font-mono text-xs text-primary hover:bg-primary/20 disabled:opacity-50"
      >
        {isPending ? 'enqueuing...' : 'create backup'}
      </button>
      {jobId ? <p className="font-mono text-xs text-ink-400">job #{jobId}</p> : null}
      {status ? (
        <div className="rounded border border-ink-800 p-3 font-mono text-xs">
          <p>
            <span className="text-ink-500">status:</span>{' '}
            <span className="text-ink-100">{status.status}</span>
          </p>
          {status.startedAt ? <p className="text-ink-500">started {new Date(status.startedAt).toLocaleString()}</p> : null}
          {status.finishedAt ? <p className="text-ink-500">finished {new Date(status.finishedAt).toLocaleString()}</p> : null}
          {status.lastError ? <p className="text-destructive">{status.lastError}</p> : null}
          {status.blobUrl ? (
            <a
              href={status.blobUrl}
              className="mt-2 inline-block rounded border border-secondary/50 bg-secondary/10 px-3 py-1 text-secondary hover:bg-secondary/20"
            >
              download zip
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
