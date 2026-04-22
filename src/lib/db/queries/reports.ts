import { db } from '../client';
import { reports } from '../schema';

export async function addReport(
  targetType: 'image' | 'comment',
  targetId: number,
  reason: string | null,
  ipHash: string
): Promise<void> {
  const fk = targetType === 'image' ? { imageId: targetId } : { commentId: targetId };
  await db.insert(reports).values({ targetType, ...fk, reason, ipHash });
}
