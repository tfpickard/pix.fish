import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import { getImageBySlug } from '@/lib/db/queries/images';
import { resolvePrompt } from '@/lib/prompts';
import { getPlaygroundTextRunner, parsePromptJson } from '@/lib/playground/llm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_STEPS = 8;

// Map a 0..1 temperature onto a drift instruction. The walk is metaphorical:
// there is no per-step vector math (inverting embeddings to text is a research
// problem). The LLM narrates a coherent drift and temperature just controls
// how far each step is allowed to roam.
function temperatureHint(t: number): string {
  if (t <= 0.25) return 'Drift only slightly. Keep most of the previous image; change one thing.';
  if (t <= 0.6) return 'Drift moderately. Keep the thread but let the subject or setting shift.';
  return 'Wander hard. Make a bold leap while keeping one thread of continuity.';
}

export async function GET(req: Request) {
  const session = await auth();
  if (!isSiteAdmin(session) || !session?.user?.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const url = new URL(req.url);
  const seedSlug = (url.searchParams.get('seed') ?? '').trim();
  if (!seedSlug) {
    return NextResponse.json({ error: 'seed slug is required' }, { status: 400 });
  }
  const stepsRaw = Number(url.searchParams.get('steps') ?? '5');
  const steps = Number.isFinite(stepsRaw) ? Math.max(1, Math.min(MAX_STEPS, Math.trunc(stepsRaw))) : 5;
  const tRaw = Number(url.searchParams.get('temperature') ?? '0.5');
  const temperature = Number.isFinite(tRaw) ? Math.max(0, Math.min(1, tRaw)) : 0.5;

  const seed = await getImageBySlug(seedSlug);
  if (!seed) {
    return NextResponse.json({ error: 'seed image not found' }, { status: 404 });
  }
  const seedCaption =
    seed.captions.find((c) => c.isSlugSource)?.text ?? seed.captions[0]?.text ?? seed.slug;

  const runner = await getPlaygroundTextRunner();
  if (!runner) {
    return NextResponse.json(
      { steps: [], warning: 'no text provider configured for the site admin.' },
      { status: 200 }
    );
  }

  const hint = temperatureHint(temperature);
  const out: string[] = [];
  let previous = '';
  // Sequential by necessity: each step feeds on the one before it.
  for (let i = 0; i < steps; i++) {
    const prompt = await resolvePrompt('walk_step', {
      seed_caption: seedCaption,
      previous_prompt: previous,
      temperature_hint: hint
    });
    let raw: string;
    try {
      raw = await runner.run(prompt);
    } catch (err) {
      console.error('walk step failed at', i, err);
      break;
    }
    const next = parsePromptJson(raw);
    if (!next) break;
    out.push(next);
    previous = next;
  }

  return NextResponse.json({ seed: { slug: seed.slug, caption: seedCaption }, steps: out });
}
