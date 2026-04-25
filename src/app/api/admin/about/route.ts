import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import { listAboutFields } from '@/lib/db/queries/about';
import { getSiteAdminId } from '@/lib/db/queries/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return NextResponse.json({ rows: await listAboutFields(getSiteAdminId()) });
}
