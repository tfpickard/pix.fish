import { NextResponse } from 'next/server';
import { auth, isOwner } from '@/lib/auth';
import { revokeApiKey } from '@/lib/db/queries/api-keys';

export async function DELETE(_req: Request, ctx: { params: { id: string } }) {
  const session = await auth();
  if (!isOwner(session)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const ownerId = session!.user!.githubId as string;

  const id = parseInt(ctx.params.id, 10);
  if (isNaN(id)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });

  await revokeApiKey(id, ownerId);
  return new NextResponse(null, { status: 204 });
}
