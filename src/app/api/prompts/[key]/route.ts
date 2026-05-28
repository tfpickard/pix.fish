import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import { updatePrompt, PROMPT_KEY_SET, type PromptKey } from '@/lib/db/queries/prompts';

export async function PATCH(req: Request, ctx: { params: { key: string } }) {
  const session = await auth();
  if (!isSiteAdmin(session)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const key = ctx.params.key as PromptKey;
  if (!PROMPT_KEY_SET.has(key)) return NextResponse.json({ error: 'invalid key' }, { status: 400 });

  let template: string;
  try {
    const body = await req.json();
    template = typeof body.template === 'string' ? body.template.trim() : '';
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  if (!template) return NextResponse.json({ error: 'template required' }, { status: 400 });

  const row = await updatePrompt(key, template);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(row);
}
