import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth, isSiteAdmin } from '@/lib/auth';
import { createSavedPrompt, listSavedPrompts } from '@/lib/db/queries/saved-prompts';
import { getSiteAdminId } from '@/lib/db/queries/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  name: z.string().min(1).max(120),
  key: z.enum(['caption', 'description', 'tags']),
  template: z.string().min(1),
  fragments: z.unknown().optional()
});

export async function GET() {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  return NextResponse.json({ rows: await listSavedPrompts(getSiteAdminId()) });
}

export async function POST(req: Request) {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', issues: parsed.error.issues }, { status: 400 });
  }
  const row = await createSavedPrompt({ ...parsed.data, ownerId: getSiteAdminId() });
  return NextResponse.json({ row }, { status: 201 });
}
