import { eq, and, desc } from 'drizzle-orm';
import { db } from '../client';
import { comments, images, users } from '../schema';
import type { Comment } from '../schema';

export type CommentStatus = 'pending' | 'approved' | 'rejected';

// Public-facing comment shape with author identity resolved. The route /
// render layer consumes this; the raw drizzle row (`Comment`) stays internal
// so we can keep evolving the table without breaking call sites.
export type CommentAuthor =
  | { kind: 'user'; handle: string; displayName: string | null }
  | {
      kind: 'guest';
      name: string | null;
      city: string | null;
      region: string | null;
      country: string | null;
    };

export type PublicComment = {
  id: number;
  body: string;
  createdAt: Date;
  author: CommentAuthor;
};

export async function addComment(params: {
  imageId: number;
  userId: string | null;
  authorName: string | null;
  body: string;
  ipHash: string;
  status: CommentStatus;
  geoCity: string | null;
  geoRegion: string | null;
  geoCountry: string | null;
}): Promise<Comment> {
  const [row] = await db
    .insert(comments)
    .values({
      imageId: params.imageId,
      userId: params.userId,
      authorName: params.authorName,
      body: params.body,
      ipHash: params.ipHash,
      status: params.status,
      geoCity: params.geoCity,
      geoRegion: params.geoRegion,
      geoCountry: params.geoCountry
    })
    .returning();
  return row;
}

// Shared SELECT + LEFT JOIN users -- both list helpers project the same
// columns plus author identity from the users table when user_id is set.
function buildAuthor(row: {
  userId: string | null;
  userHandle: string | null;
  userDisplayName: string | null;
  authorName: string | null;
  geoCity: string | null;
  geoRegion: string | null;
  geoCountry: string | null;
}): CommentAuthor {
  // The user row can be absent (LEFT JOIN miss) for two reasons: the
  // comment is from a guest (user_id IS NULL), or the user was deleted
  // (FK on delete: set null already nulled out user_id). Either way, fall
  // back to the guest rendering branch -- which is the safe default.
  if (row.userId && row.userHandle) {
    return {
      kind: 'user',
      handle: row.userHandle,
      displayName: row.userDisplayName
    };
  }
  return {
    kind: 'guest',
    name: row.authorName,
    city: row.geoCity,
    region: row.geoRegion,
    country: row.geoCountry
  };
}

export async function listApprovedComments(imageId: number): Promise<PublicComment[]> {
  const rows = await db
    .select({
      id: comments.id,
      body: comments.body,
      createdAt: comments.createdAt,
      userId: comments.userId,
      authorName: comments.authorName,
      geoCity: comments.geoCity,
      geoRegion: comments.geoRegion,
      geoCountry: comments.geoCountry,
      userHandle: users.handle,
      userDisplayName: users.displayName
    })
    .from(comments)
    .leftJoin(users, eq(users.id, comments.userId))
    .where(and(eq(comments.imageId, imageId), eq(comments.status, 'approved')))
    .orderBy(desc(comments.createdAt));
  return rows.map((r) => ({
    id: r.id,
    body: r.body,
    createdAt: r.createdAt,
    author: buildAuthor(r)
  }));
}

// Moderation queue projection. Carries enough to distinguish signed-in
// from guest commenters and surface guest geo for spam triage; the slug
// lets the admin link straight to the image.
export type ModerationComment = PublicComment & {
  status: CommentStatus;
  imageSlug: string;
};

export async function listCommentsByStatus(
  status: CommentStatus
): Promise<ModerationComment[]> {
  const rows = await db
    .select({
      id: comments.id,
      body: comments.body,
      createdAt: comments.createdAt,
      userId: comments.userId,
      authorName: comments.authorName,
      geoCity: comments.geoCity,
      geoRegion: comments.geoRegion,
      geoCountry: comments.geoCountry,
      userHandle: users.handle,
      userDisplayName: users.displayName,
      status: comments.status,
      imageSlug: images.slug
    })
    .from(comments)
    .innerJoin(images, eq(comments.imageId, images.id))
    .leftJoin(users, eq(users.id, comments.userId))
    .where(eq(comments.status, status))
    .orderBy(desc(comments.createdAt));
  return rows.map((r) => ({
    id: r.id,
    body: r.body,
    createdAt: r.createdAt,
    author: buildAuthor(r),
    status: r.status as CommentStatus,
    imageSlug: r.imageSlug
  }));
}

export async function setCommentStatus(
  id: number,
  status: 'approved' | 'rejected'
): Promise<Comment | null> {
  const [row] = await db
    .update(comments)
    .set({ status })
    .where(eq(comments.id, id))
    .returning();
  return row ?? null;
}

export async function deleteComment(id: number): Promise<void> {
  await db.delete(comments).where(eq(comments.id, id));
}

// Phase F: comment moderation gating. Returns the owner_id of the image
// the comment is on, so route handlers can pass it to canEdit() (which
// allows the image's owner OR a site admin). Returns null when the
// comment doesn't exist.
export async function getCommentImageOwner(commentId: number): Promise<string | null> {
  const [row] = await db
    .select({ ownerId: images.ownerId })
    .from(comments)
    .innerJoin(images, eq(images.id, comments.imageId))
    .where(eq(comments.id, commentId))
    .limit(1);
  return row?.ownerId ?? null;
}
