import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth, isSiteAdmin } from '@/lib/auth';
import { listAiConfig, upsertAiConfig } from '@/lib/db/queries/ai-config';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { VOYAGE_MODEL } from '@/lib/ai/imageEmbed';

// LLM call sites that still DON'T have their own row above. "derived" ones route
// through an existing field's provider/model (so they follow whatever you set for
// that field); "hardcoded" ones bypass ai_config entirely. Surfaced read-only so
// the routing isn't invisible -- the models are pulled from the live config / the
// source constant so this can't drift. (The character pipeline, nsfw rescan, and
// chat widget used to live here too; they now have their own editable rows.)
async function buildReference() {
  const cfg = await loadAiConfig();
  const cap = `${cfg.captions.provider} / ${cfg.captions.model}`;
  const desc = `${cfg.descriptions.provider} / ${cfg.descriptions.model}`;
  return {
    derived: [
      { feature: '/about generator', via: 'captions', model: cap },
      { feature: 'breed tool', via: 'descriptions', model: desc },
      { feature: '/play tools (compose, reverse-haiku, ...)', via: 'descriptions', model: desc }
    ],
    hardcoded: [{ feature: 'visual crop embeddings', model: `voyage / ${VOYAGE_MODEL}` }]
  };
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FIELDS = [
  'captions',
  'descriptions',
  'tags',
  'embeddings',
  'detect',
  'verify',
  'dossier',
  'nsfw',
  'chat',
  'imagegen'
] as const;
const PROVIDERS = ['anthropic', 'openai', 'openrouter', 'stub'] as const;

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
  const reference = await buildReference();
  return NextResponse.json({ rows, reference });
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
