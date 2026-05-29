import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import { resolvePrompt } from '@/lib/prompts';
import { parseVariantsJson } from '@/lib/ai/types';
import { getPlaygroundTextRunner } from '@/lib/playground/llm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_HAIKU_LEN = 400;

export async function POST(req: Request) {
  const session = await auth();
  if (!isSiteAdmin(session) || !session?.user?.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { haiku?: unknown } | null;
  const haiku = typeof body?.haiku === 'string' ? body.haiku.trim() : '';
  if (!haiku) {
    return NextResponse.json({ error: 'haiku is required' }, { status: 400 });
  }
  if (haiku.length > MAX_HAIKU_LEN) {
    return NextResponse.json({ error: 'haiku is too long' }, { status: 400 });
  }

  const runner = await getPlaygroundTextRunner();
  if (!runner) {
    return NextResponse.json(
      { prompts: [], warning: 'no text provider configured for the site admin.' },
      { status: 200 }
    );
  }

  const prompt = await resolvePrompt('reverse_haiku', { haiku });
  let raw: string;
  try {
    raw = await runner.run(prompt);
  } catch (err) {
    console.error('reverse-haiku generation failed', err);
    return NextResponse.json({ error: 'generation failed' }, { status: 502 });
  }

  const prompts = parseVariantsJson(raw).filter(Boolean);
  return NextResponse.json({ prompts });
}
