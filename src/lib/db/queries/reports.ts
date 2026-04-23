import { db } from '../client';
import { reports, type Report } from '../schema';

export async function addReport(
  targetType: 'image' | 'comment',
  targetId: number,
  reason: string | null,
  ipHash: string
): Promise<Report> {
  const fk = targetType === 'image' ? { imageId: targetId } : { commentId: targetId };
  const [row] = await db.insert(reports).values({ targetType, ...fk, reason, ipHash }).returning();
  if (!row) throw new Error('addReport returned no row');
  return row;
}
