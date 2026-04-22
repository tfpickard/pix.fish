'use client';

import { useState, useEffect, useTransition, useRef } from 'react';
import { Copy, Check, Trash2 } from 'lucide-react';

type ApiKey = { id: number; label: string | null; lastUsedAt: string | null; createdAt: string };

function formatDate(d: string | null): string {
  if (!d) return 'never';
  return new Date(d).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function NewTokenDisplay({ token, onDismiss }: { token: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(token).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="rounded-lg border border-secondary/40 bg-secondary/5 p-4 space-y-3">
      <p className="font-mono text-xs text-secondary">
        new token -- copy it now. it will not be shown again.
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 rounded border border-ink-800 bg-ink-950 px-3 py-2 font-mono text-xs text-ink-100 break-all">
          {token}
        </code>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 text-ink-400 hover:text-ink-100 transition-colors"
          aria-label="copy token"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        className="font-mono text-xs text-ink-500 hover:text-ink-100"
      >
        dismiss
      </button>
    </div>
  );
}

export default function AdminKeysPage() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState('');
  const [newToken, setNewToken] = useState<string | null>(null);
  const [createError, setCreateError] = useState('');
  const [isPending, startTransition] = useTransition();
  const labelRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch('/api/api-keys')
      .then((r) => r.json())
      .then((data) => { setKeys(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  function create(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim()) return;
    setCreateError('');
    startTransition(async () => {
      const res = await fetch('/api/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim() })
      });
      if (res.ok) {
        const data = await res.json();
        setNewToken(data.token);
        setLabel('');
        // Refresh key list
        fetch('/api/api-keys').then((r) => r.json()).then(setKeys);
      } else {
        const data = await res.json().catch(() => ({}));
        setCreateError(data.error ?? 'create failed');
      }
    });
  }

  function revoke(id: number) {
    startTransition(async () => {
      await fetch(`/api/api-keys/${id}`, { method: 'DELETE' });
      setKeys((prev) => prev.filter((k) => k.id !== id));
    });
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="font-display text-2xl text-ink-100">api keys</h1>
        <p className="font-mono text-xs text-ink-500">
          personal access tokens for <code className="text-accent">POST /api/images</code> from scripts
        </p>
      </div>

      {newToken && (
        <NewTokenDisplay token={newToken} onDismiss={() => setNewToken(null)} />
      )}

      {/* Create form */}
      <form onSubmit={create} className="flex items-end gap-3">
        <div className="flex-1 space-y-1">
          <label className="font-mono text-xs text-ink-500">label</label>
          <input
            ref={labelRef}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. phone-script"
            maxLength={80}
            className="w-full rounded border border-ink-800 bg-ink-900/40 px-3 py-1.5 font-mono text-xs text-ink-100 placeholder:text-ink-500 focus:border-primary/40 focus:outline-none"
          />
        </div>
        <button
          type="submit"
          disabled={isPending || !label.trim()}
          className="font-mono text-xs uppercase tracking-wide text-primary hover:text-primary/70 disabled:opacity-40"
        >
          {isPending ? 'generating...' : 'generate'}
        </button>
      </form>
      {createError && <p className="font-mono text-xs text-destructive">{createError}</p>}

      {/* Key list */}
      {loading ? (
        <p className="font-mono text-xs text-ink-500">loading...</p>
      ) : keys.length === 0 ? (
        <p className="font-mono text-xs text-ink-500">no keys yet</p>
      ) : (
        <div className="divide-y divide-ink-800 rounded-lg border border-ink-800">
          {keys.map((k) => (
            <div key={k.id} className="flex items-center justify-between px-4 py-3">
              <div className="space-y-0.5">
                <span className="font-mono text-sm text-ink-100">{k.label ?? 'unnamed'}</span>
                <div className="flex gap-4 font-mono text-xs text-ink-500">
                  <span>created {formatDate(k.createdAt)}</span>
                  <span>last used {formatDate(k.lastUsedAt)}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => revoke(k.id)}
                disabled={isPending}
                className="text-ink-600 hover:text-destructive transition-colors disabled:opacity-40"
                aria-label="revoke key"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
