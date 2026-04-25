import { NextResponse } from 'next/server';
import { auth, canEdit } from '@/lib/auth';
import {
  setCommentStatus,
  deleteComment,
  getCommentImageOwner
} from '@/lib/db/queries/comments';

// Phase F: comment moderation gating. Image owners moderate their own
// images' comments; site admins can override (canEdit allows admin role
// regardless of resource owner). Returning 404 (not 403) when the
// comment doesn't exist matches the rest of the API surface.
async function authorizeForComment(commentId: number) {
  const session = await auth();
  const ownerId = await getCommentImageOwner(commentId);
  if (ownerId === null) return { ok: false as const, status: 404 };
  if (!canEdit(session, ownerId)) return { ok: false as const, status: 403 };
  return { ok: true as const };
}

export async function PATCH(req: Request, ctx: { params: { id: string } }) {
  const id = parseInt(ctx.params.id, 10);
  if (isNaN(id)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });

  const auth = await authorizeForComment(id);
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.status === 404 ? 'not found' : 'forbidden' },
      { status: auth.status }
    );
  }

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
  const id = parseInt(ctx.params.id, 10);
  if (isNaN(id)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });

  const auth = await authorizeForComment(id);
  if (!auth.ok) {
    return NextResponse.json(
      { error: auth.status === 404 ? 'not found' : 'forbidden' },
      { status: auth.status }
    );
  }

  await deleteComment(id);
  return new NextResponse(null, { status: 204 });
}
