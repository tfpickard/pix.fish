import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import { getAboutField, updateAboutContent, upsertAboutField } from '@/lib/db/queries/about';
import { getSiteAdminId } from '@/lib/db/queries/users';
import { generateAboutContent } from '@/lib/about/generate';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, ctx: { params: { key: string } }) {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const key = ctx.params.key;
  const ownerId = getSiteAdminId();
  const existing = await getAboutField(ownerId, key);
  const label = existing?.label ?? key;

  let content: string;
  try {
    content = await generateAboutContent(label, existing?.content ?? null);
  } catch (err) {
    console.error('about: generation failed for', key, err);
    return NextResponse.json({ error: 'generation failed' }, { status: 502 });
  }

  // Persist the generated text so refresh/reload shows what the owner saw.
  // upsert so a generate on a not-yet-persisted key still works.
  const row = existing
    ? await updateAboutContent(ownerId, key, content)
    : await upsertAboutField({ ownerId, key, label, content, sortOrder: 0 });
  return NextResponse.json({ row });
}
