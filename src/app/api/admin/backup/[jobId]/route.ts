import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { auth, isSiteAdmin } from '@/lib/auth';
import { db } from '@/lib/db/client';
import { jobs } from '@/lib/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
  // Deliberately do not return the underlying blob URL. It's stored public
  // in Vercel Blob (SDK limitation) so we keep it server-side and stream
  // through the /download sibling route instead of handing the raw URL to
  // the browser.
  const payload = (row.payload as { resultUrl?: string } | null) ?? {};
  return NextResponse.json({
    status: row.status,
    hasResult: Boolean(payload.resultUrl),
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    lastError: row.lastError
  });
}
