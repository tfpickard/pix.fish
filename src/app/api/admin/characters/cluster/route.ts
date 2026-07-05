import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth, isSiteAdmin } from '@/lib/auth';
import { enqueueJob } from '@/lib/db/queries/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z
  .object({
    minAppearances: z.number().int().min(2).max(50).optional()
  })
  .default({});

// Enqueue the clustering census: group all crops into recurring characters and
// file one character.census event. The stamp is set here so a reclaimed/re-run
// job reuses it (collapses through the census dedupe key) rather than filing a
// duplicate census.
export async function POST(req: Request) {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', issues: parsed.error.issues }, { status: 400 });
  }
  const payload = {
    minAppearances: parsed.data.minAppearances ?? 2,
    stamp: Date.now() % 2_147_483_647
  };
  const job = await enqueueJob({ type: 'characters.cluster', payload, maxAttempts: 1 });
  return NextResponse.json({ jobId: job.id });
}
