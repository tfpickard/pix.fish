import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth, isSiteAdmin } from '@/lib/auth';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { allImageIds, staleCount, staleImageIds } from '@/lib/db/queries/reprocess';
import { enqueueJob } from '@/lib/db/queries/jobs';
import type { ProviderField } from '@/lib/ai';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FIELDS = ['captions', 'descriptions', 'tags', 'embeddings'] as const;

const bodySchema = z.object({
  scope: z.enum(['stale', 'all']),
  fields: z.array(z.enum(FIELDS)).min(1),
  imageIds: z.array(z.number().int().positive()).optional()
});

// GET: current config + stale counts per field. The admin UI uses this to
// render action buttons and the "N stale" counter next to each field.
export async function GET() {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const cfg = await loadAiConfig();
  const stale = await Promise.all(
    FIELDS.map(async (f) => ({
      field: f,
      provider: cfg[f].provider,
      model: cfg[f].model,
      stale: await staleCount(f, cfg[f].provider, cfg[f].model)
    }))
  );
  return NextResponse.json({ fields: stale });
}

export async function POST(req: Request) {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', issues: parsed.error.issues }, { status: 400 });
  }
  const { scope, fields, imageIds: explicitIds } = parsed.data;
  const cfg = await loadAiConfig();

  // Union of imageIds needing at least one of the requested fields.
  const targets = new Set<number>();
  if (explicitIds && explicitIds.length > 0) {
    for (const id of explicitIds) targets.add(id);
  } else if (scope === 'all') {
    for (const id of await allImageIds()) targets.add(id);
  } else {
    for (const f of fields as ProviderField[]) {
      const ids = await staleImageIds(f, cfg[f].provider, cfg[f].model);
      for (const id of ids) targets.add(id);
    }
  }

  let enqueued = 0;
  for (const imageId of targets) {
    await enqueueJob({
      type: 'reprocess.image',
      payload: { imageId, fields }
    });
    enqueued++;
  }
  return NextResponse.json({ enqueued, imageCount: targets.size });
}
