import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import { enqueueIfNoneInFlight } from '@/lib/db/queries/jobs';
import { countDesirePaths } from '@/lib/db/queries/desire-paths';
import { countTrafficEdges } from '@/lib/db/queries/path-traffic';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET: current desire-path stats -- how many routes are promoted / retired and
// how many worn edges exist to assemble from. Used by the admin UI to show
// whether promotion has anything to work with.
export async function GET() {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const [{ active, retired }, edgeCount] = await Promise.all([
    countDesirePaths(),
    countTrafficEdges()
  ]);
  return NextResponse.json({ active, retired, wornEdges: edgeCount });
}

// POST: enqueue a desire.promote job. Optional body overrides the promotion
// thresholds for experimentation without a redeploy:
//   { promoteFloor?: number, minEdgeValue?: number, maxRoutes?: number }
export async function POST(req: Request) {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const payload: Record<string, number> = {};
  try {
    const body = await req.json();
    for (const key of ['promoteFloor', 'minEdgeValue', 'maxRoutes'] as const) {
      const raw = body?.[key];
      if (raw === undefined) continue;
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
        return NextResponse.json({ error: `${key} must be a non-negative number` }, { status: 400 });
      }
      payload[key] = raw;
    }
  } catch {
    // No body / non-JSON is fine; the handler uses its defaults.
  }

  // Same guard as the nightly cron. Without it this endpoint could start a
  // second corpus-wide run alongside one already pending or processing, and the
  // two would duplicate caption calls and race each other's lifecycle writes --
  // the cron's atomic enqueue only ever protected against another cron.
  //
  // Reported rather than swallowed: an admin who set custom thresholds should
  // learn their run was not queued, instead of watching for an effect that is
  // never coming.
  const job = await enqueueIfNoneInFlight({ type: 'desire.promote', payload, maxAttempts: 2 });
  if (!job) {
    return NextResponse.json(
      { error: 'a desire.promote run is already in flight', skipped: true },
      { status: 409 }
    );
  }
  return NextResponse.json({ jobId: job.id });
}
