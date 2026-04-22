import { eq, and, desc } from 'drizzle-orm';
import { db } from '../client';
import { comments, images } from '../schema';
import type { Comment } from '../schema';

export async function addComment(
  imageId: number,
  body: string,
  authorName: string | null,
  ipHash: string
): Promise<Comment> {
  const [row] = await db
    .insert(comments)
    .values({ imageId, body, authorName, ipHash, status: 'pending' })
    .returning();
  return row;
}

export async function listApprovedComments(imageId: number): Promise<Comment[]> {
  return db
    .select()
    .from(comments)
    .where(and(eq(comments.imageId, imageId), eq(comments.status, 'approved')))
    .orderBy(desc(comments.createdAt));
}

export type CommentWithSlug = Comment & { imageSlug: string };

export async function listCommentsByStatus(
  status: 'pending' | 'approved' | 'rejected'
): Promise<CommentWithSlug[]> {
  const rows = await db
    .select({
      id: comments.id,
      imageId: comments.imageId,
      authorName: comments.authorName,
      body: comments.body,
      status: comments.status,
      ipHash: comments.ipHash,
      createdAt: comments.createdAt,
      imageSlug: images.slug
    })
    .from(comments)
    .innerJoin(images, eq(comments.imageId, images.id))
    .where(eq(comments.status, status))
    .orderBy(desc(comments.createdAt));
  return rows;
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
