import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import { clearFailedJobs, jobsOverview, requeueFailedJobs } from '@/lib/db/queries/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const overview = await jobsOverview(50);
  return NextResponse.json(overview);
}

type ParsedFilter =
  | { ok: true; filter: { id?: number; type?: string } }
  | { ok: false; response: NextResponse };

// Shared body parsing for the failed-job mutations (requeue via POST, clear via
// DELETE). Both take the same optional filter and both broaden to "all failed"
// on an empty body, so the same guardrails apply:
//   { id: number }   -> one failed job
//   { type: string } -> all failed jobs of that type
//   {} / empty body  -> every failed job
// Distinguish a truly empty body (all, allowed) from a malformed one: collapsing
// a JSON parse failure to {} would turn a botched single id/type request into an
// accidental global mutation, so invalid JSON is a 400. Only a genuinely
// zero-length body is "all" -- a whitespace-only body is left for JSON.parse to
// reject (it tolerates surrounding whitespace but throws on whitespace-only), so
// "   " is a 400 rather than a silent global mutation.
async function parseJobFilter(req: NextRequest): Promise<ParsedFilter> {
  const raw = await req.text();
  let body: { id?: unknown; type?: unknown } = {};
  if (raw.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, response: NextResponse.json({ error: 'invalid JSON body' }, { status: 400 }) };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ok: false, response: NextResponse.json({ error: 'invalid JSON body' }, { status: 400 }) };
    }
    body = parsed as { id?: unknown; type?: unknown };
  }

  const filter: { id?: number; type?: string } = {};
  if (body.id !== undefined) {
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) {
      return { ok: false, response: NextResponse.json({ error: 'invalid id' }, { status: 400 }) };
    }
    filter.id = id;
  }
  if (body.type !== undefined) {
    if (typeof body.type !== 'string' || body.type.length === 0) {
      return { ok: false, response: NextResponse.json({ error: 'invalid type' }, { status: 400 }) };
    }
    filter.type = body.type;
  }

  // A non-empty object that yielded no recognized filter (e.g. a typo like
  // { jobId: 123 }) must not silently fall through to a global mutation.
  // "All" is only the explicit `{}` / empty-body path.
  if (Object.keys(body).length > 0 && filter.id === undefined && filter.type === undefined) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'no recognized filter; send an empty body or {} to affect all failed jobs' },
        { status: 400 }
      )
    };
  }

  return { ok: true, filter };
}

// Requeue failed jobs so the cron drain retries them. The work happens on the
// next cron tick; this only flips the rows to pending.
export async function POST(req: NextRequest) {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const parsed = await parseJobFilter(req);
  if (!parsed.ok) return parsed.response;
  const requeued = await requeueFailedJobs(parsed.filter);
  return NextResponse.json({ requeued });
}

// Clear (delete) failed jobs so the category's failed count drops to zero and
// the failures are forgotten. Destructive and irreversible -- unlike requeue,
// nothing is retried and no history is kept.
export async function DELETE(req: NextRequest) {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const parsed = await parseJobFilter(req);
  if (!parsed.ok) return parsed.response;
  const cleared = await clearFailedJobs(parsed.filter);
  return NextResponse.json({ cleared });
}
