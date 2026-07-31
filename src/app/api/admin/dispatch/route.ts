import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import { enqueueJob, hasInFlightJobOfType } from '@/lib/db/queries/jobs';
import { countDispatchOutcomes, listRecentDispatchEvents } from '@/lib/db/queries/dispatch';
import { dispatchMinuteForDate, driftForDate, utcDateKey } from '@/lib/dispatch/schedule';
import { DRIFT_ENABLED, captionCharBudget, dispatchLiveEnabled } from '@/lib/dispatch/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Review surface for the outbound X dispatch. GET returns the dispatch slice of
// the event log (every would-be post and every skip, with its reason); POST
// enqueues an immediate review run.

export async function GET(req: Request) {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const now = new Date();
  const dateKey = utcDateKey(now);
  // Bounded page SIZE plus an offset, so the whole history is reachable rather
  // than capped: limit alone made 200 a ceiling on what could ever be read.
  const params = new URL(req.url).searchParams;
  const rawLimit = Number(params.get('limit') ?? 60);
  const rawOffset = Number(params.get('offset') ?? 0);
  const limit = Number.isFinite(rawLimit) ? rawLimit : 60;
  const offset = Number.isFinite(rawOffset) ? rawOffset : 0;
  const [events, totalOutcomes] = await Promise.all([
    listRecentDispatchEvents(limit, offset),
    countDispatchOutcomes()
  ]);
  return NextResponse.json({
    // Phase 1 has no X client, so nothing can post regardless of this flag. It is
    // surfaced so the review page can show how the deployment is configured.
    liveEnvEnabled: dispatchLiveEnabled(),
    livePostingImplemented: false,
    charBudget: captionCharBudget(),
    today: {
      dateKey,
      targetUtcMinute: dispatchMinuteForDate(dateKey),
      // Must carry the same DRIFT_ENABLED gate the handler applies. driftForDate
      // alone answers "would today drift", which is not the question the review
      // page is asking -- it would announce "drift variant" for a quarter of days
      // that then ship a standard caption, and the one surface meant to tell the
      // truth about the run would be the one lying about it.
      driftVariant: DRIFT_ENABLED && driftForDate(dateKey)
    },
    totalOutcomes,
    // Echoed back so a caller (and the review page's load-more) can page without
    // re-deriving the clamp this route applied.
    offset: Math.max(Math.trunc(offset), 0),
    hasMore: Math.max(Math.trunc(offset), 0) + events.length < totalOutcomes,
    events: events.map((e) => ({
      id: e.id,
      type: e.type,
      dateKey: e.subjectId,
      payload: e.payload,
      createdAt: e.createdAt
    }))
  });
}

// A review run. It claims a suffixed slot rather than the real day's slot, so
// generating samples for review never consumes the day's single dispatch -- and
// never blocks the scheduled one. Always forced to dry run.
export async function POST() {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (await hasInFlightJobOfType('x.dispatch')) {
    return NextResponse.json({ enqueued: false, reason: 'dispatch already in flight' });
  }
  const now = new Date();
  const job = await enqueueJob({
    type: 'x.dispatch',
    payload: {
      dateKey: utcDateKey(now),
      trigger: 'manual',
      claimSuffix: `manual:${now.getTime()}`,
      dryRun: true
    },
    maxAttempts: 1
  });
  return NextResponse.json({ enqueued: 'x.dispatch', jobId: job.id });
}
