import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth, isOwner } from '@/lib/auth';
import { enqueueJob } from '@/lib/db/queries/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z
  .object({
    nNeighbors: z.number().int().min(2).max(100).optional(),
    minDist: z.number().min(0).max(1).optional()
  })
  .default({});

export async function POST(req: Request) {
  if (!isOwner(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', issues: parsed.error.issues }, { status: 400 });
  }
  const { nNeighbors = 15, minDist = 0.1 } = parsed.data;
  const job = await enqueueJob({
    type: 'umap.recompute',
    payload: { nNeighbors, minDist, kind: 'caption' }
  });
  return NextResponse.json({ jobId: job.id });
}
