import { asc } from 'drizzle-orm';
import { db } from '../client';
import { vibeAxes } from '../schema';
import type { VibeAxis, NewVibeAxis } from '../schema';

// All axes in display order. Soft-fails to [] if the table is missing
// (pre-migration) so the equalizer tab can render an empty state instead of
// crashing the whole /admin/play page.
export async function listVibeAxes(): Promise<VibeAxis[]> {
  try {
    return await db.select().from(vibeAxes).orderBy(asc(vibeAxes.ordering), asc(vibeAxes.id));
  } catch {
    return [];
  }
}

// Replace the entire axis set in one transaction. Used by
// scripts/vibe-axes.ts --write once the owner has picked a derivation
// approach; re-running with a new approach cleanly swaps rather than merging.
export async function replaceVibeAxes(rows: NewVibeAxis[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(vibeAxes);
    if (rows.length > 0) await tx.insert(vibeAxes).values(rows);
  });
}
