import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { auth, isOwner } from '@/lib/auth';
import { db } from '@/lib/db/client';
import { jobs } from '@/lib/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: { jobId: string } }) {
  if (!isOwner(await auth())) {
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
  const payload = (row.payload as { resultUrl?: string } | null) ?? {};
  return NextResponse.json({
    status: row.status,
    blobUrl: payload.resultUrl ?? null,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    lastError: row.lastError
  });
}
