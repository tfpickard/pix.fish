import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth, isSiteAdmin } from '@/lib/auth';
import { listAiConfig, upsertAiConfig } from '@/lib/db/queries/ai-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FIELDS = ['captions', 'descriptions', 'tags', 'embeddings'] as const;
const PROVIDERS = ['anthropic', 'openai'] as const;

const putSchema = z.object({
  field: z.enum(FIELDS),
  provider: z.enum(PROVIDERS),
  model: z.string().min(1).max(120)
});

export async function GET() {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const rows = await listAiConfig();
  return NextResponse.json({ rows });
}

export async function PUT(req: Request) {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', issues: parsed.error.issues }, { status: 400 });
  }
  const row = await upsertAiConfig(parsed.data.field, parsed.data.provider, parsed.data.model);
  return NextResponse.json({ row });
}
