import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth, isSiteAdmin } from '@/lib/auth';
import { getTuning, saveTuning } from '@/lib/db/queries/character-tuning';
import { enqueueJob } from '@/lib/db/queries/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Enqueue the clustering pipeline (cluster -> verify -> census). Any knobs in the
// body are persisted as the new defaults (so the sliders stick) AND passed in the
// job payload for this run. Omitted knobs fall back to the saved tuning. The run
// stamp is set here so a reclaimed/re-run cluster reuses it (collapses through the
// census dedupe key) rather than filing a duplicate census.
const bodySchema = z
  .object({
    maxDist: z.number().min(0.05).max(1).optional(),
    k: z.number().int().min(1).max(30).optional(),
    pruneK: z.number().int().min(1).max(30).optional(),
    minAppearances: z.number().int().min(2).max(50).optional(),
    verifyEnabled: z.boolean().optional(),
    space: z.enum(['text', 'visual', 'blend']).optional(),
    blendWeight: z.number().min(0).max(1).optional()
  })
  .default({});

export async function POST(req: Request) {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', issues: parsed.error.issues }, { status: 400 });
  }

  // Persist any provided knobs, then resolve the effective set from storage.
  if (Object.keys(parsed.data).length > 0) await saveTuning(parsed.data);
  const tuning = await getTuning();

  const payload = {
    runStamp: Date.now() % 2_147_483_647,
    minAppearances: tuning.minAppearances,
    maxDist: tuning.maxDist,
    k: tuning.k,
    pruneK: tuning.pruneK,
    verifyEnabled: tuning.verifyEnabled,
    space: tuning.space,
    blendWeight: tuning.blendWeight
  };
  const job = await enqueueJob({ type: 'characters.cluster', payload, maxAttempts: 1 });
  return NextResponse.json({ jobId: job.id, tuning });
}
