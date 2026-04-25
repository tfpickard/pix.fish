import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { auth, isSiteAdmin } from '@/lib/auth';
import { db } from '@/lib/db/client';
import { jobs } from '@/lib/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Streaming a large zip past the function wall ends the response mid-body.
// 60s is enough for galleries under ~50GB on typical connections; tune up if
// it trips.
export const maxDuration = 60;

// Owner-gated download. We fetch the public-access blob server-side and
// stream it back to the browser so the raw blob URL never leaves this
// process. If @vercel/blob adds a private-access mode, this is the single
// place to swap in a signed-URL read.
export async function GET(_req: Request, ctx: { params: { jobId: string } }) {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const id = Number(ctx.params.jobId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  if (!row || row.type !== 'backup.export') {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const payload = (row.payload as { resultUrl?: string; resultPathname?: string } | null) ?? {};
  if (!payload.resultUrl) {
    return NextResponse.json({ error: 'backup not ready' }, { status: 409 });
  }
  const upstream = await fetch(payload.resultUrl);
  if (!upstream.ok || !upstream.body) {
    return NextResponse.json({ error: 'upstream fetch failed' }, { status: 502 });
  }
  const filename = payload.resultPathname?.split('/').pop() ?? `backup-${id}.zip`;
  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, no-store'
    }
  });
}
