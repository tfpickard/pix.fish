import { db } from '../client';
import { reports } from '../schema';

export async function addReport(
  targetType: 'image' | 'comment',
  targetId: number,
  reason: string | null,
  ipHash: string
): Promise<void> {
  await db.insert(reports).values({ targetType, targetId, reason, ipHash });
}
