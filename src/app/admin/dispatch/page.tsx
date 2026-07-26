'use client';

import { useCallback, useEffect, useState } from 'react';

// Review surface for the outbound X dispatch. In dry run the assembled post is
// the deliverable, so this page renders it in full -- image, caption, hashtags,
// the trend it rode, and the classifier verdict that cleared it -- alongside
// every skipped day and why. Nothing here posts anything.

type SentPayload = {
  mode: string;
  imageId: number;
  slug: string;
  handle: string;
  blobUrl: string;
  isNsfw: boolean;
  caption: string;
  hashtags: string[];
  drift: boolean;
  trendTopic: string;
  trendSource: string;
  trendHeadlines: string[];
  safetyCategory: string;
  safetyConfidence: string;
  safetyReason: string;
  distance: number;
  model: string;
  postId: string | null;
};

type SkippedPayload = { mode: string; reason: string; detail: string; trendTopic: string | null };

type Row = {
  id: number;
  type: string;
  dateKey: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

type Data = {
  liveEnvEnabled: boolean;
  livePostingImplemented: boolean;
  charBudget: number;
  today: { dateKey: string; targetUtcMinute: number; driftVariant: boolean };
  events: Row[];
};

function utcMinuteLabel(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')} UTC`;
}

function SentCard({ row }: { row: Row }) {
  const p = row.payload as unknown as SentPayload;
  return (
    <div className="rounded border border-ink-800 p-3 font-mono text-xs">
      <div className="flex flex-wrap items-center gap-2 text-ink-500">
        <span className="text-secondary">would post</span>
        <span>{row.dateKey}</span>
        <span>/</span>
        <span>{p.mode}</span>
        {p.drift ? <span className="text-secondary">drift variant</span> : null}
        {p.isNsfw ? <span className="text-destructive">nsfw specimen</span> : null}
      </div>

      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={p.blobUrl}
          alt={p.slug}
          className="h-32 w-32 shrink-0 rounded object-cover"
        />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="whitespace-pre-wrap font-sans text-sm text-ink-100">{p.caption}</p>
          <p className="text-ink-500">
            {p.caption.length} chars / {p.hashtags.join(' ') || 'no hashtag'}
          </p>
          <p className="text-ink-500">
            specimen {p.imageId}{' '}
            <a href={`/u/${p.handle}/${p.slug}`} className="text-secondary hover:underline">
              {p.slug}
            </a>{' '}
            / cosine {p.distance.toFixed(3)} / {p.model}
          </p>
        </div>
      </div>

      <div className="mt-3 border-t border-ink-800 pt-2 text-ink-500">
        <p>
          trend: <span className="text-ink-300">{p.trendTopic}</span> ({p.trendSource}) / verdict:{' '}
          <span className="text-ink-300">
            {p.safetyCategory}, {p.safetyConfidence}
          </span>{' '}
          {p.safetyReason ? `-- ${p.safetyReason}` : ''}
        </p>
        {p.trendHeadlines?.length ? (
          <ul className="mt-1 space-y-0.5">
            {p.trendHeadlines.map((h) => (
              <li key={h}>- {h}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function SkippedCard({ row }: { row: Row }) {
  const p = row.payload as unknown as SkippedPayload;
  return (
    <div className="rounded border border-ink-800 p-3 font-mono text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ink-400">no post</span>
        <span className="text-ink-500">{row.dateKey}</span>
        <span className="text-destructive">{p.reason}</span>
        {p.trendTopic ? <span className="text-ink-500">/ {p.trendTopic}</span> : null}
      </div>
      {p.detail ? <p className="mt-1 text-ink-500">{p.detail}</p> : null}
    </div>
  );
}

export default function AdminDispatchPage() {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(() => {
    fetch('/api/admin/dispatch')
      .then(async (r) => {
        if (r.status === 403) {
          setForbidden(true);
          return null;
        }
        return r.json();
      })
      .then((d) => {
        if (d) setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  async function runNow() {
    setRunning(true);
    setNotice(null);
    try {
      const res = await fetch('/api/admin/dispatch', { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `run failed (${res.status})`);
      setNotice(
        body.enqueued
          ? `queued review run (job ${body.jobId}); drains within a minute`
          : (body.reason ?? 'not queued')
      );
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'run failed');
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    load();
    const iv = setInterval(load, 10_000);
    return () => clearInterval(iv);
  }, [load]);

  if (forbidden) {
    return <p className="font-mono text-xs text-ink-500">site admins only.</p>;
  }

  const sent = data?.events.filter((e) => e.type === 'dispatch.sent') ?? [];
  const skipped = data?.events.filter((e) => e.type === 'dispatch.skipped') ?? [];

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="font-display text-3xl text-ink-100">dispatch</h1>

      <div className="flex flex-wrap items-center gap-3">
        <p className="font-mono text-xs text-ink-500">
          outbound X dispatch. one per day, dry run only.
        </p>
        <button
          type="button"
          onClick={runNow}
          disabled={running}
          className="rounded border border-ink-700 px-2 py-1 font-mono text-xs text-ink-300 hover:bg-ink-800 disabled:opacity-50"
        >
          {running ? 'queueing...' : 'run a review dispatch'}
        </button>
        {notice ? <span className="font-mono text-xs text-secondary">{notice}</span> : null}
      </div>

      {data ? (
        <section className="rounded border border-ink-800 p-3 font-mono text-xs text-ink-500">
          <p>
            live posting:{' '}
            <span className="text-ink-300">
              {data.livePostingImplemented ? 'implemented' : 'not implemented (phase 2)'}
            </span>
            {' / '}X_DISPATCH_LIVE:{' '}
            <span className="text-ink-300">{data.liveEnvEnabled ? 'true' : 'unset'}</span>
            {' / '}caption budget: <span className="text-ink-300">{data.charBudget} chars</span>
          </p>
          <p className="mt-1">
            today ({data.today.dateKey}): fires at{' '}
            <span className="text-ink-300">{utcMinuteLabel(data.today.targetUtcMinute)}</span>
            {data.today.driftVariant ? ', drift variant' : ', standard variant'}
          </p>
        </section>
      ) : null}

      <section className="space-y-3">
        <h2 className="font-mono text-xs text-ink-500">dispatches ({sent.length})</h2>
        {loading ? (
          <p className="font-mono text-xs text-ink-500">loading...</p>
        ) : sent.length === 0 ? (
          <p className="font-mono text-xs text-ink-500">nothing dispatched yet</p>
        ) : (
          sent.map((row) => <SentCard key={row.id} row={row} />)
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-mono text-xs text-ink-500">skipped ({skipped.length})</h2>
        {skipped.length === 0 ? (
          <p className="font-mono text-xs text-ink-500">no skips on file</p>
        ) : (
          skipped.map((row) => <SkippedCard key={row.id} row={row} />)
        )}
      </section>
    </div>
  );
}
