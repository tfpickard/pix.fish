'use client';

import { useEffect, useState } from 'react';

type Stats = {
  totals: { images: number; captions: number; tags: number };
  uploadsPerWeek: { week: string; count: number }[];
  topTags: { tag: string; count: number }[];
  commentsByStatus: { status: string; count: number }[];
  reactionsByKind: { kind: string; count: number }[];
  embeddingCoverage: { embedded: number; total: number; pct: number };
  jobsByTypeStatus: { type: string; status: string; count: number }[];
  recentJobFailures: number;
  webhookSuccessRate: { status: string; count: number }[];
};

function Bar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max === 0 ? 0 : (value / max) * 100;
  return (
    <div className="flex items-center gap-2 font-mono text-xs">
      <span className="w-32 truncate text-ink-400">{label}</span>
      <div className="relative h-4 flex-1 rounded bg-ink-900">
        <div
          className="absolute inset-y-0 left-0 rounded bg-primary/40"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-10 text-right text-ink-400">{value}</span>
    </div>
  );
}

export default function AdminStatsPage() {
  const [data, setData] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/admin/stats')
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) {
    return <p className="font-mono text-xs text-ink-500">loading stats...</p>;
  }
  if (!data) return <p className="font-mono text-xs text-ink-500">stats unavailable</p>;

  const weekMax = Math.max(1, ...data.uploadsPerWeek.map((r) => r.count));
  const tagMax = Math.max(1, ...data.topTags.map((r) => r.count));

  return (
    <div className="max-w-3xl space-y-8">
      <h1 className="font-display text-3xl text-ink-100">stats</h1>

      <section>
        <h2 className="font-mono text-xs text-ink-500 mb-2">totals</h2>
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded border border-ink-800 p-3 font-mono text-xs">
            <p className="text-ink-500">images</p>
            <p className="text-xl text-ink-100">{data.totals.images}</p>
          </div>
          <div className="rounded border border-ink-800 p-3 font-mono text-xs">
            <p className="text-ink-500">captions</p>
            <p className="text-xl text-ink-100">{data.totals.captions}</p>
          </div>
          <div className="rounded border border-ink-800 p-3 font-mono text-xs">
            <p className="text-ink-500">tags</p>
            <p className="text-xl text-ink-100">{data.totals.tags}</p>
          </div>
        </div>
      </section>

      <section>
        <h2 className="font-mono text-xs text-ink-500 mb-2">embedding coverage</h2>
        <Bar
          label={`${data.embeddingCoverage.embedded}/${data.embeddingCoverage.total}`}
          value={data.embeddingCoverage.embedded}
          max={Math.max(1, data.embeddingCoverage.total)}
        />
        <p className="mt-1 font-mono text-xs text-ink-500">
          {(data.embeddingCoverage.pct * 100).toFixed(1)}%
        </p>
      </section>

      <section>
        <h2 className="font-mono text-xs text-ink-500 mb-2">uploads per week (last 12)</h2>
        <div className="space-y-1">
          {data.uploadsPerWeek.length === 0 ? (
            <p className="font-mono text-xs text-ink-500">no uploads in the last 12 weeks</p>
          ) : (
            data.uploadsPerWeek.map((r) => (
              <Bar key={r.week} value={r.count} max={weekMax} label={r.week} />
            ))
          )}
        </div>
      </section>

      <section>
        <h2 className="font-mono text-xs text-ink-500 mb-2">top tags</h2>
        <div className="space-y-1">
          {data.topTags.map((r) => (
            <Bar key={r.tag} value={r.count} max={tagMax} label={r.tag} />
          ))}
        </div>
      </section>

      <section className="grid grid-cols-2 gap-6">
        <div>
          <h2 className="font-mono text-xs text-ink-500 mb-2">comments</h2>
          {data.commentsByStatus.map((r) => (
            <p key={r.status} className="font-mono text-xs">
              <span className="text-ink-400">{r.status}</span>:{' '}
              <span className="text-ink-100">{r.count}</span>
            </p>
          ))}
        </div>
        <div>
          <h2 className="font-mono text-xs text-ink-500 mb-2">reactions</h2>
          {data.reactionsByKind.map((r) => (
            <p key={r.kind} className="font-mono text-xs">
              <span className="text-ink-400">{r.kind}</span>:{' '}
              <span className="text-ink-100">{r.count}</span>
            </p>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-2 gap-6">
        <div>
          <h2 className="font-mono text-xs text-ink-500 mb-2">jobs</h2>
          {data.jobsByTypeStatus.length === 0 ? (
            <p className="font-mono text-xs text-ink-500">no jobs yet</p>
          ) : (
            data.jobsByTypeStatus.map((r) => (
              <p key={`${r.type}-${r.status}`} className="font-mono text-xs">
                <span className="text-ink-400">
                  {r.type}/{r.status}
                </span>
                : <span className="text-ink-100">{r.count}</span>
              </p>
            ))
          )}
          <p className="mt-1 font-mono text-xs text-destructive">
            failed in last 24h: {data.recentJobFailures}
          </p>
        </div>
        <div>
          <h2 className="font-mono text-xs text-ink-500 mb-2">webhook deliveries (24h)</h2>
          {data.webhookSuccessRate.length === 0 ? (
            <p className="font-mono text-xs text-ink-500">no deliveries</p>
          ) : (
            data.webhookSuccessRate.map((r) => (
              <p key={r.status} className="font-mono text-xs">
                <span className="text-ink-400">{r.status}</span>:{' '}
                <span className="text-ink-100">{r.count}</span>
              </p>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
