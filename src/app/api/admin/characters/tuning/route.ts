import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth, isSiteAdmin } from '@/lib/auth';
import { getTuning, saveTuning } from '@/lib/db/queries/character-tuning';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Clustering knobs, persisted as a singleton so the admin sliders' last-used
// values become the defaults for the next cluster run. GET reads, PUT saves.

const putSchema = z
  .object({
    maxDist: z.number().min(0.05).max(1).optional(),
    k: z.number().int().min(1).max(30).optional(),
    pruneK: z.number().int().min(1).max(30).optional(),
    minAppearances: z.number().int().min(2).max(50).optional(),
    verifyEnabled: z.boolean().optional()
  })
  .default({});

export async function GET() {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return NextResponse.json(await getTuning());
}

export async function PUT(req: Request) {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const parsed = putSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', issues: parsed.error.issues }, { status: 400 });
  }
  await saveTuning(parsed.data);
  return NextResponse.json(await getTuning());
}
