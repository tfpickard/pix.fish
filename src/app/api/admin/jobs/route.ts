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
  const body = (await req.json().catch(() => ({}))) as { id?: unknown; type?: unknown };

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

  const requeued = await requeueFailedJobs(filter);
  return NextResponse.json({ requeued });
}
