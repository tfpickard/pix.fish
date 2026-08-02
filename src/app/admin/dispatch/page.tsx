'use client';

import { useCallback, useEffect, useState } from 'react';
import { weightedLength } from '@/lib/dispatch/weighted-length';

// Review surface for the outbound X dispatch. In dry run the assembled post is
// the deliverable, so this page renders it in full -- image, caption, hashtags,
// the trend it rode, and the classifier verdict that cleared it -- alongside
// every skipped day and why. Nothing here posts anything.

type SentPayload = {
  mode: string;
  trigger?: string;
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
  postUrl?: string | null;
};

type SkippedPayload = {
  mode: string;
  trigger?: string;
  reason: string;
  detail: string;
  trendTopic: string | null;
};

// A review sample and the day's scheduled artifact are both drafts for the same
// date; without this they read as duplicates on the page.
//
// Manual no longer implies dry. Now that an admin can post live by hand, calling
// every manual row a "review run" would label real published posts as samples --
// so the badge reads the mode, not just the trigger.
function TriggerBadge({ trigger, mode }: { trigger?: string; mode?: string }) {
  if (trigger !== 'manual') return null;
  const live = mode === 'live';
  return (
    <span
      className={`rounded border px-1 ${live ? 'border-accent text-accent' : 'border-ink-700 text-ink-400'}`}
    >
      {live ? 'manual post' : 'review run'}
    </span>
  );
}

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
  liveCredentialsPresent: boolean;
  missingXCredentials: string[];
  charBudget: number;
  today: { dateKey: string; targetUtcMinute: number; driftVariant: boolean };
  totalOutcomes: number;
  // Complete set, independent of pagination -- see the note where it is used.
  unresolvedAttempts: Row[];
  offset: number;
  hasMore: boolean;
  events: Row[];
};

const PAGE_SIZE = 60;

// Merge a freshly fetched page into what is already on screen, newest first.
// Union by event id rather than concatenating: the poll re-fetches page 0 while
// older pages are already loaded, so overlap is the normal case, not an error.
function mergeRows(existing: Row[], incoming: Row[]): Row[] {
  const byId = new Map<number, Row>();
  for (const r of existing) byId.set(r.id, r);
  for (const r of incoming) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => b.id - a.id);
}

function utcMinuteLabel(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')} UTC`;
}

function SentCard({
  row,
  canApprove,
  onApprove,
  busy
}: {
  row: Row;
  canApprove: boolean;
  onApprove: (id: number) => void;
  busy: boolean;
}) {
  const p = row.payload as unknown as SentPayload;
  // An unposted draft is a proposal awaiting sign-off. Approval publishes THIS
  // text, so the card the admin reads is exactly what goes out.
  const awaitingApproval = !p.postId;
  return (
    <div className="rounded border border-ink-800 p-3 font-mono text-xs">
      <div className="flex flex-wrap items-center gap-2 text-ink-500">
        {/* The label has to follow the row, not the page: a log holds drafts and
            real posts side by side, and calling a post that exists "would post"
            is the audit surface contradicting the account. */}
        <span className="text-secondary">{p.postId ? 'posted' : 'draft'}</span>
        <span>{row.dateKey}</span>
        <span>/</span>
        <span>{p.mode}</span>
        <TriggerBadge trigger={p.trigger} mode={p.mode} />
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
          {/* X's weighted count, not string length -- the same number
              validateCaption enforced. A CJK caption reads at half its real
              cost under .length, which would make a post that is over budget
              look comfortably inside it on the one surface meant to catch that. */}
          <p className="text-ink-500">
            {weightedLength(p.caption)} weighted chars /{' '}
            {p.hashtags.join(' ') || 'no hashtag'}
          </p>
          {p.postId ? (
            <p className="text-ink-500">
              posted{' '}
              <a
                href={p.postUrl ?? `https://x.com/i/web/status/${p.postId}`}
                target="_blank"
                rel="noreferrer"
                className="text-secondary hover:underline"
              >
                {p.postId}
              </a>
            </p>
          ) : null}
          <p className="text-ink-500">
            specimen {p.imageId}{' '}
            <a href={`/u/${p.handle}/${p.slug}`} className="text-secondary hover:underline">
              {p.slug}
            </a>{' '}
            / cosine {p.distance.toFixed(3)} / {p.model}
          </p>
          {/* Only offered when the deployment could actually post. Elsewhere a
              draft is just a draft, and a button that refuses is worse than no
              button -- that lesson is what produced this whole approval flow. */}
          {awaitingApproval && canApprove ? (
            <button
              type="button"
              onClick={() => onApprove(row.id)}
              disabled={busy}
              className="rounded border border-accent px-2 py-1 font-mono text-xs text-accent hover:bg-ink-800 disabled:opacity-50"
            >
              {busy ? 'publishing...' : 'approve and post this'}
            </button>
          ) : null}
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
        {/* An indeterminate outcome must not read as "no post": the request
            reached X and the answer was lost, so a post may exist. Saying "no
            post" there is the audit page asserting something it does not know. */}
        {p.reason === 'post_indeterminate' ? (
          <span className="text-secondary">POST MAY EXIST -- check the account</span>
        ) : (
          <span className="text-ink-400">no post</span>
        )}
        <span className="text-ink-500">{row.dateKey}</span>
        <span className="text-destructive">{p.reason}</span>
        <TriggerBadge trigger={p.trigger} mode={p.mode} />
        {p.trendTopic ? <span className="text-ink-500">/ {p.trendTopic}</span> : null}
      </div>
      {p.detail ? <p className="mt-1 text-ink-500">{p.detail}</p> : null}
    </div>
  );
}

export default function AdminDispatchPage() {
  const [data, setData] = useState<Data | null>(null);
  // Accumulated across pages, so "load more" adds to the view instead of
  // replacing it and the 10s poll does not throw older pages away.
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [running, setRunning] = useState(false);
  // Event id of the draft currently being published, so only its button spins.
  const [approving, setApproving] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  // Refreshes the newest page only. Anything already paged in stays put.
  const load = useCallback(() => {
    fetch(`/api/admin/dispatch?limit=${PAGE_SIZE}`)
      .then(async (r) => {
        if (r.status === 403) {
          setForbidden(true);
          return null;
        }
        return r.json();
      })
      .then((d: Data | null) => {
        if (d) {
          setData(d);
          setRows((prev) => mergeRows(prev, d.events));
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Pages backwards from what is already loaded. The log only ever appends at the
  // newest end, so an offset taken from the current count can shift by whatever
  // arrived in between; merging by id absorbs the resulting overlap.
  const loadMore = useCallback(async () => {
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/admin/dispatch?limit=${PAGE_SIZE}&offset=${rows.length}`);
      if (!res.ok) return;
      const d: Data = await res.json();
      setRows((prev) => mergeRows(prev, d.events));
      setData((prev) => (prev ? { ...prev, totalOutcomes: d.totalOutcomes } : d));
    } catch {
      // A failed page is not worth an error state; the button stays available.
    } finally {
      setLoadingMore(false);
    }
  }, [rows.length]);

  async function runNow() {
    setRunning(true);
    setNotice(null);
    try {
      // A manual run never posts, so there is nothing here to confirm. The
      // confirmation moved to approval, which is where something irreversible
      // actually happens and where the operator has read what it will publish.
      const res = await fetch('/api/admin/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok && !body.reason) throw new Error(body.error ?? `run failed (${res.status})`);
      setNotice(
        body.enqueued
          ? `queued a draft (job ${body.jobId}); drains within a minute, then approve it below`
          : (body.reason ?? 'not queued')
      );
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'run failed');
    } finally {
      setRunning(false);
    }
  }

  async function approve(eventId: number) {
    // The one irreversible action on this page, so it is the one that asks.
    if (
      !window.confirm(
        'Publish this draft to X?\n\nThe caption above is posted exactly as written. This cannot be undone.'
      )
    ) {
      return;
    }
    setApproving(eventId);
    setNotice(null);
    try {
      const res = await fetch('/api/admin/dispatch/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId })
      });
      const body = await res.json().catch(() => ({}));
      // A refusal answers 409 with a reason naming what is not configured.
      if (!res.ok && !body.reason) throw new Error(body.error ?? `approve failed (${res.status})`);
      setNotice(
        body.approved
          ? `queued publication (job ${body.jobId}); drains within a minute`
          : (body.reason ?? 'not approved')
      );
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'approve failed');
    } finally {
      setApproving(null);
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

  const sent = rows.filter((e) => e.type === 'dispatch.sent');
  const skipped = rows.filter((e) => e.type === 'dispatch.skipped');
  // An attempt is written immediately before the X call. One with no outcome of
  // its own means a post was started and never confirmed -- the post may well be
  // public, and this is the only surviving trace when the outcome write itself
  // fails.
  //
  // Taken from the API's own query, NOT filtered out of `rows`. Deriving it from
  // the loaded page tied the warning to how far back the operator had scrolled:
  // once an attempt aged past the first 60 events it vanished, so the page
  // dropped its single most important claim exactly as the incident got older.
  // The server correlates attempts to outcomes by slot -- one date can hold many
  // independent runs, so a date match would let any one of them vouch for the
  // rest.
  const unconfirmed = data?.unresolvedAttempts ?? [];
  const total = data?.totalOutcomes ?? 0;
  const hasMore = rows.length < total;

  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="font-display text-3xl text-ink-100">dispatch</h1>

      {/*
        Loudest thing on the page, and first. Every other row describes something
        that definitely happened or definitely did not; these describe a post that
        may be live on the account with nothing recording it. That is the only
        state here a human has to go and reconcile by hand.
      */}
      {unconfirmed.length > 0 ? (
        <section className="rounded border border-accent p-3 font-mono text-xs text-accent">
          <p className="font-bold">
            {unconfirmed.length} unconfirmed attempt{unconfirmed.length === 1 ? '' : 's'} -- check
            the account
          </p>
          <p className="mt-1 text-ink-400">
            A post was started and no outcome was ever recorded for it. The post may be public.
          </p>
          <ul className="mt-2 space-y-1">
            {unconfirmed.map((e) => (
              <li key={e.id}>
                {e.dateKey} -- {String(e.payload.slug ?? `image ${e.payload.imageId}`)}{' '}
                <span className="text-ink-500">
                  ({String(e.payload.trigger ?? 'cron')}, slot {String(e.payload.slotKey)})
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <p className="font-mono text-xs text-ink-500">
          outbound X dispatch. scheduled posts once a day on its own; manual
          drafts are unlimited and post only when approved.{' '}
          {data?.liveEnvEnabled && data?.liveCredentialsPresent
            ? 'LIVE -- approving a draft posts it to X.'
            : 'dry run only -- drafts cannot be published.'}
        </p>
        {/* One button, because a manual run has one behaviour now: it drafts.
            Publishing lives on the draft itself, where the caption being
            published is on screen next to the button that publishes it. */}
        <button
          type="button"
          onClick={() => runNow()}
          disabled={running}
          className="rounded border border-ink-700 px-2 py-1 font-mono text-xs text-ink-300 hover:bg-ink-800 disabled:opacity-50"
        >
          {running ? 'queueing...' : 'generate a draft'}
        </button>
        {notice ? <span className="font-mono text-xs text-secondary">{notice}</span> : null}
      </div>

      {data ? (
        <section className="rounded border border-ink-800 p-3 font-mono text-xs text-ink-500">
          <p>
            live posting:{' '}
            <span className="text-ink-300">
              {data.livePostingImplemented ? 'implemented' : 'not implemented'}
              {data.livePostingImplemented && !data.liveCredentialsPresent
                ? ` (runs stay dry -- missing: ${
                    data.missingXCredentials?.length
                      ? data.missingXCredentials.join(', ')
                      : 'unknown'
                  })`
                : ''}
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
          sent.map((row) => (
            <SentCard
              key={row.id}
              row={row}
              canApprove={Boolean(data?.liveEnvEnabled && data?.liveCredentialsPresent)}
              onApprove={approve}
              busy={approving === row.id}
            />
          ))
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

      {total > 0 ? (
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs text-ink-500">
            showing {rows.length} of {total} outcomes
          </span>
          {hasMore ? (
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="rounded border border-ink-700 px-2 py-1 font-mono text-xs text-ink-300 hover:bg-ink-800 disabled:opacity-50"
            >
              {loadingMore ? 'loading...' : 'load older'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
