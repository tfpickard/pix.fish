import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth, isOwner } from '@/lib/auth';
import { getAboutField, updateAboutContent, upsertAboutField } from '@/lib/db/queries/about';
import { getSiteAdminId } from '@/lib/db/queries/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  content: z.string().max(4000).optional(),
  label: z.string().min(1).max(120).optional(),
  sortOrder: z.number().int().optional()
});

export async function PATCH(req: Request, ctx: { params: { key: string } }) {
  if (!isOwner(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const key = ctx.params.key;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', issues: parsed.error.issues }, { status: 400 });
  }
  // If only content is being updated, take the lighter path; otherwise
  // upsert the full row so a missing key still creates a record.
  const ownerId = getSiteAdminId();
  if (parsed.data.content !== undefined && parsed.data.label === undefined && parsed.data.sortOrder === undefined) {
    const row = await updateAboutContent(ownerId, key, parsed.data.content);
    if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ row });
  }
  const existing = await getAboutField(ownerId, key);
  const label = parsed.data.label ?? existing?.label ?? key;
  const row = await upsertAboutField({
    ownerId,
    key,
    label,
    content: parsed.data.content ?? existing?.content ?? '',
    sortOrder: parsed.data.sortOrder ?? existing?.sortOrder ?? 0
  });
  return NextResponse.json({ row });
}
