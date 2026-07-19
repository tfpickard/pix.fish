import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth, isSiteAdmin } from '@/lib/auth';
import { listAiConfig, upsertAiConfig } from '@/lib/db/queries/ai-config';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { NSFW_SCAN_MODEL } from '@/lib/ai/nsfwClassifier';
import { PISCI_MODEL } from '@/lib/ai/pisci-chat';
import { VOYAGE_MODEL } from '@/lib/ai/imageEmbed';

// Other LLM call sites that DON'T have their own row above. "derived" ones route
// through an existing field's provider/model (so they follow whatever you set for
// that field); "hardcoded" ones bypass ai_config entirely. Surfaced read-only so
// the routing isn't invisible -- see the models pulled straight from the source
// constants so this can't drift. (Making these independently selectable is a
// follow-up; today this is visibility only.)
async function buildReference() {
  const cfg = await loadAiConfig();
  const cap = `${cfg.captions.provider} / ${cfg.captions.model}`;
  const desc = `${cfg.descriptions.provider} / ${cfg.descriptions.model}`;
  return {
    derived: [
      { feature: 'character detection (figures)', via: 'captions', model: cap },
      { feature: 'character verify (mosaic)', via: 'captions', model: cap },
      { feature: 'character census (dossier synthesis)', via: 'captions', model: cap },
      { feature: 'universe amend (dossier)', via: 'captions', model: cap },
      { feature: '/about generator', via: 'captions', model: cap },
      { feature: 'breed tool', via: 'descriptions', model: desc },
      { feature: '/play tools (compose, reverse-haiku, ...)', via: 'descriptions', model: desc }
    ],
    hardcoded: [
      { feature: 'nsfw rescan job', model: `anthropic / ${NSFW_SCAN_MODEL}` },
      { feature: 'pisci chat assistant', model: `anthropic / ${PISCI_MODEL}` },
      { feature: 'visual crop embeddings', model: `voyage / ${VOYAGE_MODEL}` }
    ]
  };
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FIELDS = ['captions', 'descriptions', 'tags', 'embeddings', 'imagegen'] as const;
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
