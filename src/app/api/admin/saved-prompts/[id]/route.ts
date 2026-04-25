import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth, isOwner } from '@/lib/auth';
import {
  deleteSavedPrompt,
  getSavedPrompt,
  updateSavedPrompt
} from '@/lib/db/queries/saved-prompts';
import { getSiteAdminId } from '@/lib/db/queries/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  template: z.string().min(1).optional(),
  fragments: z.unknown().optional()
});

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function PATCH(req: Request, ctx: { params: { id: string } }) {
  if (!isOwner(await auth())) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const id = parseId(ctx.params.id);
  if (!id) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', issues: parsed.error.issues }, { status: 400 });
  }
  const row = await updateSavedPrompt(getSiteAdminId(), id, parsed.data);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ row });
}

export async function DELETE(_req: Request, ctx: { params: { id: string } }) {
  if (!isOwner(await auth())) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const id = parseId(ctx.params.id);
  if (!id) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const ownerId = getSiteAdminId();
  const existing = await getSavedPrompt(ownerId, id);
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 });
  await deleteSavedPrompt(ownerId, id);
  return NextResponse.json({ ok: true });
}
