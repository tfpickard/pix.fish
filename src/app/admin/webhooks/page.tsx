'use client';

import { useEffect, useState, useTransition } from 'react';
import { Copy, Check, Trash2 } from 'lucide-react';

type Webhook = {
  id: number;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
};

const EVENTS = ['image.created', 'image.updated', 'comment.created', 'report.created'] as const;

function NewSecret({ secret, onDismiss }: { secret: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(secret).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <div className="rounded-lg border border-secondary/40 bg-secondary/5 p-4 space-y-3">
      <p className="font-mono text-xs text-secondary">
        signing secret -- copy it now. it will not be shown again.
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 rounded border border-ink-800 bg-ink-950 px-3 py-2 font-mono text-xs text-ink-100 break-all">
          {secret}
        </code>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 text-ink-400 hover:text-ink-100 transition-colors"
          aria-label="copy secret"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <button type="button" onClick={onDismiss} className="font-mono text-xs text-ink-500 hover:text-ink-100">
        dismiss
      </button>
    </div>
  );
}

export default function AdminWebhooksPage() {
  const [rows, setRows] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['image.created']);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [isPending, startTransition] = useTransition();

  function load() {
    fetch('/api/admin/webhooks')
      .then((r) => r.json())
      .then((data) => {
        setRows(data.webhooks ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }

  useEffect(load, []);

  function toggle(ev: string) {
    setEvents((prev) => (prev.includes(ev) ? prev.filter((e) => e !== ev) : [...prev, ev]));
  }

  function create(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!url.trim() || events.length === 0) return;
    startTransition(async () => {
      const res = await fetch('/api/admin/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), events })
      });
      if (res.ok) {
        const data = await res.json();
        setNewSecret(data.webhook.secret);
        setUrl('');
        load();
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? 'failed to create');
      }
    });
  }

  async function remove(id: number) {
    await fetch(`/api/admin/webhooks/${id}`, { method: 'DELETE' });
    load();
  }

  async function setActive(id: number, active: boolean) {
    await fetch(`/api/admin/webhooks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active })
    });
    load();
  }

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="font-display text-3xl text-ink-100">webhooks</h1>
      <p className="font-mono text-xs text-ink-500">
        outbound http posts fired after image / comment / report events. each webhook is
        signed with an HMAC-SHA256 secret in the X-Pix-Signature header.
      </p>

      {newSecret ? <NewSecret secret={newSecret} onDismiss={() => setNewSecret(null)} /> : null}

      <form onSubmit={create} className="space-y-3 rounded-lg border border-ink-800 p-4">
        <label className="block font-mono text-xs text-ink-500">
          url
          <input
            type="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/hook"
            className="mt-1 w-full rounded border border-ink-800 bg-ink-950 px-3 py-2 font-mono text-sm text-ink-100 focus:border-primary/50 focus:outline-none"
          />
        </label>
        <div>
          <p className="font-mono text-xs text-ink-500 mb-2">events</p>
          <div className="grid grid-cols-2 gap-2">
            {EVENTS.map((ev) => (
              <label key={ev} className="flex items-center gap-2 font-mono text-xs text-ink-300">
                <input type="checkbox" checked={events.includes(ev)} onChange={() => toggle(ev)} />
                {ev}
              </label>
            ))}
          </div>
        </div>
        {error ? <p className="font-mono text-xs text-destructive">{error}</p> : null}
        <button
          type="submit"
          disabled={isPending}
          className="rounded border border-primary/50 bg-primary/10 px-3 py-1.5 font-mono text-xs text-primary hover:bg-primary/20 disabled:opacity-50"
        >
          {isPending ? 'creating...' : 'create'}
        </button>
      </form>

      <div className="space-y-2">
        {loading ? (
          <p className="font-mono text-xs text-ink-500">loading...</p>
        ) : rows.length === 0 ? (
          <p className="font-mono text-xs text-ink-500">no webhooks yet</p>
        ) : (
          rows.map((w) => (
            <div key={w.id} className="flex items-center gap-3 rounded border border-ink-800 p-3">
              <div className="flex-1 min-w-0">
                <p className="font-mono text-sm text-ink-100 truncate">{w.url}</p>
                <p className="font-mono text-xs text-ink-500">{w.events.join(', ')}</p>
              </div>
              <label className="flex items-center gap-1 font-mono text-xs text-ink-400">
                <input type="checkbox" checked={w.active} onChange={(e) => setActive(w.id, e.target.checked)} />
                active
              </label>
              <a
                href={`/admin/webhooks/${w.id}`}
                className="font-mono text-xs text-ink-400 hover:text-ink-100"
              >
                deliveries
              </a>
              <button
                type="button"
                onClick={() => remove(w.id)}
                className="text-ink-500 hover:text-destructive"
                aria-label="delete"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
