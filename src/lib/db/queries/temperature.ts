import { desc } from 'drizzle-orm';
import { db } from '../client';
import { collectionTemperature } from '../schema';
import type { CollectionTemperature } from '../schema';

// feat/hud: read the most recent collection-temperature reading for the HUD.
// Returns null when the series is empty (no recompute has run yet) so the
// overlay can render a neutral "warming up" state instead of a fake zero.
export async function getLatestTemperature(): Promise<CollectionTemperature | null> {
  const [row] = await db
    .select()
    .from(collectionTemperature)
    .orderBy(desc(collectionTemperature.computedAt))
    .limit(1);
  return row ?? null;
}

// The two most recent readings, newest first. Used to show a delta arrow in
// the HUD without a second round-trip.
export async function getRecentTemperatures(limit = 2): Promise<CollectionTemperature[]> {
  return db
    .select()
    .from(collectionTemperature)
    .orderBy(desc(collectionTemperature.computedAt))
    .limit(limit);
}
