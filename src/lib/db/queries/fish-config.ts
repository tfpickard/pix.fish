import { sql } from 'drizzle-orm';
import { db } from '../client';
import { fishConfig } from '../schema';
import {
  DEFAULT_FISH_MORPH_CONFIG,
  fishConfigFromFields,
  type FishMorphConfig
} from '@/lib/fish/config';

// Load the current fish morph config, parsing + clamping each stored value and
// falling back to defaults for missing/invalid fields. Returns the full default
// config if the table can't be read, so the mascot keeps working without a DB.
export async function getFishMorphConfig(): Promise<FishMorphConfig> {
  try {
    const rows = await db.select().from(fishConfig);
    const values = Object.fromEntries(rows.map((r) => [r.field, r.value]));
    return fishConfigFromFields(values);
  } catch {
    return { ...DEFAULT_FISH_MORPH_CONFIG };
  }
}

// Upsert one or more fish_config fields. Values are pre-clamped strings.
export async function setFishConfigFields(fields: Record<string, string>): Promise<void> {
  const entries = Object.entries(fields);
  if (entries.length === 0) return;
  for (const [field, value] of entries) {
    await db
      .insert(fishConfig)
      .values({ field, value })
      .onConflictDoUpdate({
        target: fishConfig.field,
        set: { value, updatedAt: sql`now()` }
      });
  }
}
