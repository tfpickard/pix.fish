import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import { listCommentsByStatus } from '@/lib/db/queries/comments';

const VALID_STATUSES = new Set(['pending', 'approved', 'rejected']);

export async function GET(req: Request) {
  const session = await auth();
  if (!isSiteAdmin(session)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const status = new URL(req.url).searchParams.get('status') ?? 'pending';
  if (!VALID_STATUSES.has(status)) {
    return NextResponse.json({ error: 'invalid status' }, { status: 400 });
  }

  const rows = await listCommentsByStatus(status as 'pending' | 'approved' | 'rejected');
  return NextResponse.json(rows);
}
