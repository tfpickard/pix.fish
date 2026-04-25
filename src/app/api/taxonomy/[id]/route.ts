import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import { deleteTaxonomyTag } from '@/lib/db/queries/taxonomy';

export async function DELETE(_req: Request, ctx: { params: { id: string } }) {
  const session = await auth();
  if (!isSiteAdmin(session)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const id = parseInt(ctx.params.id, 10);
  if (isNaN(id)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });

  await deleteTaxonomyTag(id);
  return new NextResponse(null, { status: 204 });
}
