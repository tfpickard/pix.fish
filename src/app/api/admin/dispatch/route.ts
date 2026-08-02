import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import { enqueueJob, hasInFlightJobOfType } from '@/lib/db/queries/jobs';
import {
  countDispatchOutcomes,
  listRecentDispatchEvents,
  listUnresolvedAttempts
} from '@/lib/db/queries/dispatch';
import { dispatchMinuteForDate, driftForDate, utcDateKey } from '@/lib/dispatch/schedule';
import { DRIFT_ENABLED, captionCharBudget, dispatchLiveEnabled } from '@/lib/dispatch/config';
import { getXCredentials, missingXCredentialNames } from '@/lib/dispatch/x-client';

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
  const [events, totalOutcomes, unresolvedAttempts] = await Promise.all([
    listRecentDispatchEvents(limit, offset),
    countDispatchOutcomes(),
    // Fetched independently of the page. An attempt with no outcome means a post
    // may exist with nothing recording it, and that warning must not depend on
    // how far back the operator happens to have scrolled.
    listUnresolvedAttempts()
  ]);
  return NextResponse.json({
    // How the deployment is configured. Posting needs BOTH the switch and
    // credentials; either alone means dry run.
    liveEnvEnabled: dispatchLiveEnabled(),
    livePostingImplemented: true,
    // Whether the deployment could actually post right now. The env switch alone
    // is not enough -- without credentials the handler degrades to a dry run, and
    // the review page should say so rather than implying posts are going out.
    liveCredentialsPresent: getXCredentials() !== null,
    // Names of the absent variables, so the page can say WHICH one rather than
    // leaving an operator to guess across four. Never values.
    missingXCredentials: missingXCredentialNames(),
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
    // Complete, not a slice of `events` -- see listUnresolvedAttempts.
    unresolvedAttempts: unresolvedAttempts.map((e) => ({
      id: e.id,
      type: e.type,
      dateKey: e.subjectId,
      payload: e.payload,
      createdAt: e.createdAt
    })),
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

// A manual run produces a DRAFT. It never posts.
//
// Manual dispatches go out through review and approval instead: this generates
// the artifact and writes it to the log, an admin reads it at /admin/dispatch,
// and POST /api/admin/dispatch/approve publishes that exact draft. The two-step
// exists because a caption is generated, not chosen -- the run that writes it is
// the first time anyone sees it, so "post now" meant publishing something
// unread. Approval is the point at which a human has actually looked.
//
// `{ live: true }` is still accepted and still validates the switch and the
// credentials, because an operator asking to post deserves to be told when the
// deployment cannot. It just no longer skips the reading.
//
// The SCHEDULED dispatch is deliberately unaffected and still posts without
// approval: it fires at a randomized minute with nobody watching, and a daily
// post that waits for a human is a daily post that does not happen.
//
// Every manual run claims a `manual:<ms>` suffixed slot, and none is capped.
//
// The once-per-day rule constrains the AUTOMATIC dispatch only. That is the thing
// worth rate-limiting: an account posting itself twice in a day because a cron
// fired twice is a bug, whereas an admin deciding to post four times today is a
// decision. So the suffixed slot -- originally there to stop a dry review from
// consuming the day -- is what also makes manual posting unlimited, since a slot
// that never collides is a slot that never runs out.
//
// A manual LIVE post does suppress the day's automatic one (see the cron route):
// having posted by hand, the operator should not be surprised by a second post
// from the scheduler hours later.
//
// Repeated manual posts do not repeat themselves: listDispatchedImageIds()
// excludes every already-dispatched specimen, so each run picks a new one and
// eventually skips with no_specimen rather than reposting.
export async function POST(req: Request) {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Body is optional -- a bare POST is still a review run, which is what the
  // existing button sends.
  const body = (await req.json().catch(() => ({}))) as { live?: unknown };
  const wantsLive = body.live === true;

  if (wantsLive) {
    // Refuse rather than silently degrading to a dry run. Everywhere else in this
    // feature, "not configured" means fall back to dry -- correct there, because
    // nothing asked to post. Here something did, explicitly, and a dry run
    // reported as success is how an operator concludes the linkage works when it
    // does not. That is the exact confusion this endpoint exists to end.
    if (!dispatchLiveEnabled()) {
      return NextResponse.json(
        { enqueued: false, reason: 'X_DISPATCH_LIVE is not "true" in this environment' },
        { status: 409 }
      );
    }
    const missing = missingXCredentialNames();
    if (missing.length > 0) {
      return NextResponse.json(
        { enqueued: false, reason: `missing credentials: ${missing.join(', ')}` },
        { status: 409 }
      );
    }
  }

  // Not a daily cap -- a concurrency guard, and it applies to manual runs too.
  // Two dispatches running at once would each read listDispatchedImageIds()
  // before either wrote its attempt, so both could select the SAME specimen and
  // post it twice. Serializing costs at most the drain interval.
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
      // Always a draft. A manual run's output is reviewed and approved before it
      // reaches X, so the run itself has nothing to post.
      dryRun: true
    },
    maxAttempts: 1
  });
  return NextResponse.json({
    enqueued: 'x.dispatch',
    jobId: job.id,
    // Echoed so the UI can say "draft, then approve" rather than implying a post
    // is on its way.
    awaitingApproval: true,
    liveChecked: wantsLive
  });
}
