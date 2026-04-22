import { NextResponse } from 'next/server';
import { auth, isOwner } from '@/lib/auth';
import { updatePrompt, type PromptKey } from '@/lib/db/queries/prompts';

const VALID_KEYS = new Set<PromptKey>(['caption', 'description', 'tags']);

export async function PATCH(req: Request, ctx: { params: { key: string } }) {
  const session = await auth();
  if (!isOwner(session)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const key = ctx.params.key as PromptKey;
  if (!VALID_KEYS.has(key)) return NextResponse.json({ error: 'invalid key' }, { status: 400 });

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
