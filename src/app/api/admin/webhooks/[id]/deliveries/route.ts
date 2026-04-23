import { NextResponse } from 'next/server';
import { auth, isOwner } from '@/lib/auth';
import { listDeliveries } from '@/lib/db/queries/webhooks';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: { id: string } }) {
  if (!isOwner(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const id = Number(ctx.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100) | 0, 1), 500);
  const rows = await listDeliveries(id, limit);
  return NextResponse.json({ deliveries: rows });
}
