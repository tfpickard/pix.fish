'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

type Delivery = {
  id: number;
  event: string;
  attempt: number;
  status: string;
  responseStatus: number | null;
  responseBody: string | null;
  error: string | null;
  createdAt: string;
};

export default function AdminWebhookDeliveriesPage({ params }: { params: { id: string } }) {
  const [rows, setRows] = useState<Delivery[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/admin/webhooks/${params.id}/deliveries?limit=100`)
      .then((r) => r.json())
      .then((data) => {
        setRows(data.deliveries ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [params.id]);

  return (
    <div className="max-w-3xl space-y-6">
      <Link href="/admin/webhooks" className="font-mono text-xs text-ink-500 hover:text-ink-100">
        &larr; back to webhooks
      </Link>
      <h1 className="font-display text-3xl text-ink-100">deliveries</h1>
      {loading ? (
        <p className="font-mono text-xs text-ink-500">loading...</p>
      ) : rows.length === 0 ? (
        <p className="font-mono text-xs text-ink-500">no deliveries yet</p>
      ) : (
        <div className="space-y-2">
          {rows.map((d) => (
            <div
              key={d.id}
              className={`rounded border p-3 font-mono text-xs ${
                d.status === 'success' ? 'border-ink-800' : 'border-destructive/40 bg-destructive/5'
              }`}
            >
              <div className="flex items-center gap-3">
                <span className="text-ink-300">{d.event}</span>
                <span className="text-ink-500">attempt {d.attempt}</span>
                <span className={d.status === 'success' ? 'text-ink-300' : 'text-destructive'}>
                  {d.status} {d.responseStatus ?? ''}
                </span>
                <span className="ml-auto text-ink-500">{new Date(d.createdAt).toLocaleString()}</span>
              </div>
              {d.error ? <p className="mt-1 text-destructive">{d.error}</p> : null}
              {d.responseBody ? (
                <pre className="mt-1 whitespace-pre-wrap break-words text-ink-500">{d.responseBody}</pre>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
