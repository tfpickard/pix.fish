import { NextResponse } from 'next/server';
import { auth, isOwner } from '@/lib/auth';
import { enqueueJob } from '@/lib/db/queries/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const session = await auth();
  if (!isOwner(session)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const job = await enqueueJob({
    type: 'backup.export',
    payload: { requestedBy: session!.user!.githubId! },
    maxAttempts: 1 // backup is expensive; no silent retries
  });
  return NextResponse.json({ jobId: job.id });
}
