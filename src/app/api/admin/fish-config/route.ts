import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth, isSiteAdmin } from '@/lib/auth';
import { getFishMorphConfig, setFishConfigFields } from '@/lib/db/queries/fish-config';
import { clampParam, FISH_PARAMS, type FishMorphConfig } from '@/lib/fish/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Body is a partial map of camelCase param key -> number. Each value is
// re-clamped server-side against its spec, so the client can't push the morph
// out of range regardless of what it sends.
const putSchema = z.record(z.string(), z.number()).refine((o) => Object.keys(o).length > 0, {
  message: 'no values'
});

export async function GET() {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const config = await getFishMorphConfig();
  return NextResponse.json({ config });
}

export async function PUT(req: Request) {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', issues: parsed.error.issues }, { status: 400 });
  }

  // Only persist known params; clamp each against its spec.
  const fields: Record<string, string> = {};
  for (const spec of FISH_PARAMS) {
    const incoming = parsed.data[spec.key as keyof FishMorphConfig as string];
    if (incoming === undefined) continue;
    fields[spec.field] = String(clampParam(spec, incoming));
  }

  try {
    await setFishConfigFields(fields);
  } catch {
    // The likeliest cause is a missing fish_config table (migration 0007 not
    // applied to this database). Reads fall back to defaults, but writes can't.
    return NextResponse.json(
      { error: 'could not save -- the fish_config table is missing; apply the latest db migration' },
      { status: 503 }
    );
  }

  const config = await getFishMorphConfig();
  return NextResponse.json({ config });
}
