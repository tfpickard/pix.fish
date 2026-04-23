import { NextResponse } from 'next/server';
import { auth, isOwner } from '@/lib/auth';
import { listAboutFields } from '@/lib/db/queries/about';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  if (!isOwner(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return NextResponse.json({ rows: await listAboutFields() });
}
