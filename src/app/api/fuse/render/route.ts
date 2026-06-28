import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import { readNsfwMode } from '@/lib/nsfw';
import { activeFuseIds } from '@/lib/db/queries/fuse';
import { enqueueJob, getJob } from '@/lib/db/queries/jobs';
import { hashIp, getRequestIp } from '@/lib/hash';
import { rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Admin-only live render of a /fuse pairing via OpenAI's image-2 model, run as a
// BACKGROUND JOB so the slow (paid) generation never blocks or times out the
// request: POST enqueues and returns a job id immediately; the worker (cron
// drain) runs the gpt-image-2 generation + Blob upload (see handlers/fuseRender);
// the client polls GET ?job=<id> for the result. Only the owner can spend on a
// render -- isSiteAdmin is the authoritative gate on both verbs.

async function requireAdmin(): Promise<NextResponse | null> {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: 'sign in required' }, { status: 401 });
  if (!isSiteAdmin(session)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  return null;
}

// POST { a, b } -> enqueue a fuse.render job. Returns { jobId, status: 'queued' }.
export async function POST(req: Request): Promise<NextResponse> {
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: { a?: unknown; b?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  const a = Number(body.a);
  const b = Number(body.b);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0 || a === b) {
    return NextResponse.json({ error: 'two distinct image ids required' }, { status: 400 });
  }

  // Bound accidental rapid-fire enqueues (each job is a paid generation).
  const ipHash = hashIp(getRequestIp(req));
  if (!rateLimit(`fuserender:${ipHash}`, 20, 60_000)) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 });
  }

  const nsfwMode = await readNsfwMode();
  const allowed = await activeFuseIds([a, b], nsfwMode);
  if (!allowed.has(a) || !allowed.has(b)) {
    return NextResponse.json({ error: 'unfusable ids' }, { status: 422 });
  }

  // maxAttempts: 1 -- each attempt is a paid generation, so a timeout/failure
  // must not silently retry and re-bill.
  const job = await enqueueJob({ type: 'fuse.render', payload: { a, b }, maxAttempts: 1 });
  return NextResponse.json({ jobId: job.id, status: 'queued' }, { status: 202 });
}

// GET ?job=<id> -> poll a fuse.render job's status + result.
export async function GET(req: Request): Promise<NextResponse> {
  const denied = await requireAdmin();
  if (denied) return denied;

  const id = Number(new URL(req.url).searchParams.get('job'));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'job id required' }, { status: 400 });
  }
  const job = await getJob(id);
  if (!job || job.type !== 'fuse.render') {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const payload = (job.payload ?? {}) as { url?: string };
  return NextResponse.json({
    status: job.status, // pending | processing | done | failed
    url: payload.url ?? null,
    error: job.lastError ?? null
  });
}
