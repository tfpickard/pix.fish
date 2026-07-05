import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import { jobsOverview, requeueFailedJobs } from '@/lib/db/queries/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const overview = await jobsOverview(50);
  return NextResponse.json(overview);
}

// Requeue failed jobs so the cron drain retries them. Body is optional:
//   { id: number }   -> requeue one failed job
//   { type: string } -> requeue all failed jobs of that type
//   {}               -> requeue every failed job
// The work happens on the next cron tick; this only flips the rows to pending.
export async function POST(req: NextRequest) {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  // Distinguish a truly empty body (retry-all, allowed) from a malformed one.
  // Collapsing a JSON parse failure to {} would turn a botched single id/type
  // retry into an accidental global requeue, so invalid JSON is a 400. Only a
  // genuinely zero-length body is retry-all -- a whitespace-only body is left
  // for JSON.parse to reject (it tolerates surrounding whitespace but throws on
  // whitespace-only), so "   " is a 400 rather than a silent global requeue.
  const raw = await req.text();
  let body: { id?: unknown; type?: unknown } = {};
  if (raw.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
    }
    body = parsed as { id?: unknown; type?: unknown };
  }

  const filter: { id?: number; type?: string } = {};
  if (body.id !== undefined) {
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) {
      return NextResponse.json({ error: 'invalid id' }, { status: 400 });
    }
    filter.id = id;
  }
  if (body.type !== undefined) {
    if (typeof body.type !== 'string' || body.type.length === 0) {
      return NextResponse.json({ error: 'invalid type' }, { status: 400 });
    }
    filter.type = body.type;
  }

  // A non-empty object that yielded no recognized filter (e.g. a typo like
  // { jobId: 123 }) must not silently fall through to a global requeue.
  // Retry-all is only the explicit `{}` / empty-body path handled above.
  if (Object.keys(body).length > 0 && filter.id === undefined && filter.type === undefined) {
    return NextResponse.json(
      { error: 'no recognized filter; send an empty body or {} to retry all failed jobs' },
      { status: 400 }
    );
  }

  const requeued = await requeueFailedJobs(filter);
  return NextResponse.json({ requeued });
}
