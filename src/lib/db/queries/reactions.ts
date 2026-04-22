import { eq, and, sql } from 'drizzle-orm';
import { db } from '../client';
import { reactions } from '../schema';

export type ReactionCounts = { up: number; down: number };

export async function countReactions(imageId: number): Promise<ReactionCounts> {
  const rows = await db
    .select({ kind: reactions.kind, count: sql<number>`count(*)::int` })
    .from(reactions)
    .where(eq(reactions.imageId, imageId))
    .groupBy(reactions.kind);
  const up = rows.find((r) => r.kind === 'up')?.count ?? 0;
  const down = rows.find((r) => r.kind === 'down')?.count ?? 0;
  return { up, down };
}

// Toggle reaction: same kind = delete (un-react); different kind = switch; none = insert.
// Returns the resulting counts and whether the reaction is now active.
export async function toggleReaction(
  imageId: number,
  kind: 'up' | 'down',
  ipHash: string,
  fingerprint: string | null
): Promise<{ counts: ReactionCounts; active: boolean }> {
  const existing = await db
    .select()
    .from(reactions)
    .where(and(eq(reactions.imageId, imageId), eq(reactions.ipHash, ipHash)))
    .limit(1);

  if (existing.length > 0) {
    if (existing[0].kind === kind) {
      // Same kind -- remove the reaction
      await db.delete(reactions).where(eq(reactions.id, existing[0].id));
      const counts = await countReactions(imageId);
      return { counts, active: false };
    } else {
      // Different kind -- switch
      await db
        .update(reactions)
        .set({ kind, fingerprint })
        .where(eq(reactions.id, existing[0].id));
    }
  } else {
    await db.insert(reactions).values({ imageId, kind, ipHash, fingerprint });
  }

  const counts = await countReactions(imageId);
  return { counts, active: true };
}
