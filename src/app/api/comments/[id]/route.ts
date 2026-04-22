import { NextResponse } from 'next/server';
import { auth, isOwner } from '@/lib/auth';
import { setCommentStatus, deleteComment } from '@/lib/db/queries/comments';

export async function PATCH(req: Request, ctx: { params: { id: string } }) {
  const session = await auth();
  if (!isOwner(session)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const id = parseInt(ctx.params.id, 10);
  if (isNaN(id)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });

  let status: string;
  try {
    const body = await req.json();
    status = body.status;
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  if (status !== 'approved' && status !== 'rejected') {
    return NextResponse.json({ error: 'status must be "approved" or "rejected"' }, { status: 400 });
  }

  const comment = await setCommentStatus(id, status);
  if (!comment) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(comment);
}

export async function DELETE(_req: Request, ctx: { params: { id: string } }) {
  const session = await auth();
  if (!isOwner(session)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const id = parseInt(ctx.params.id, 10);
  if (isNaN(id)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });

  await deleteComment(id);
  return new NextResponse(null, { status: 204 });
}
