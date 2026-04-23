import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth, isOwner } from '@/lib/auth';
import { deleteWebhook, getWebhook, updateWebhook } from '@/lib/db/queries/webhooks';
import { WEBHOOK_EVENTS } from '@/lib/webhooks/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  url: z.string().url().optional(),
  active: z.boolean().optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional()
});

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function PATCH(req: Request, ctx: { params: { id: string } }) {
  if (!isOwner(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const id = parseId(ctx.params.id);
  if (!id) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', issues: parsed.error.issues }, { status: 400 });
  }
  const row = await updateWebhook(id, parsed.data);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json({ webhook: { ...row, secret: undefined } });
}

export async function DELETE(_req: Request, ctx: { params: { id: string } }) {
  if (!isOwner(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const id = parseId(ctx.params.id);
  if (!id) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const existing = await getWebhook(id);
  if (!existing) return NextResponse.json({ error: 'not found' }, { status: 404 });
  await deleteWebhook(id);
  return NextResponse.json({ ok: true });
}
