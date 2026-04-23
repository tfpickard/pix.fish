import { NextResponse } from 'next/server';
import { auth, isOwner } from '@/lib/auth';
import { jobsOverview } from '@/lib/db/queries/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  if (!isOwner(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const overview = await jobsOverview(50);
  return NextResponse.json(overview);
}
