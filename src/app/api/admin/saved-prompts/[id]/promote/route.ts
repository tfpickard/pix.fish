import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import { getSavedPrompt } from '@/lib/db/queries/saved-prompts';
import { getSiteAdminId } from '@/lib/db/queries/users';
import { updatePrompt, type PromptKey } from '@/lib/db/queries/prompts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_KEYS = new Set<PromptKey>(['caption', 'description', 'tags']);

export async function POST(_req: Request, ctx: { params: { id: string } }) {
  if (!isSiteAdmin(await auth())) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const id = Number(ctx.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  const saved = await getSavedPrompt(getSiteAdminId(), id);
  if (!saved) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const key = saved.key as PromptKey;
  if (!VALID_KEYS.has(key)) {
    return NextResponse.json({ error: `unknown prompt key "${saved.key}"` }, { status: 400 });
  }
  const row = await updatePrompt(key, saved.template);
  if (!row) return NextResponse.json({ error: 'prompt not found' }, { status: 404 });
  return NextResponse.json({ prompt: row });
}
