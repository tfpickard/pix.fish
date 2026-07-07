import { eq, sql } from 'drizzle-orm';
import { db } from '../client';
import { characterTuning, type CharacterTuning } from '../schema';

// Singleton (id = 1) config for the clustering knobs. The admin sliders persist
// their last-used values here so they become the defaults for the next run.

export type ClusterSpace = 'text' | 'visual' | 'blend';

export const TUNING_DEFAULTS = {
  maxDist: 0.45,
  k: 5,
  pruneK: 4,
  minAppearances: 2,
  verifyEnabled: true,
  space: 'text' as ClusterSpace,
  blendWeight: 0.5
};

export type TuningKnobs = typeof TUNING_DEFAULTS;

function coerceSpace(s: string): ClusterSpace {
  return s === 'visual' || s === 'blend' ? s : 'text';
}

export async function getTuning(): Promise<TuningKnobs> {
  const [row] = await db.select().from(characterTuning).where(eq(characterTuning.id, 1)).limit(1);
  if (!row) return { ...TUNING_DEFAULTS };
  return {
    maxDist: row.maxDist,
    k: row.k,
    pruneK: row.pruneK,
    minAppearances: row.minAppearances,
    verifyEnabled: row.verifyEnabled,
    space: coerceSpace(row.space),
    blendWeight: row.blendWeight
  };
}

export async function saveTuning(knobs: Partial<TuningKnobs>): Promise<CharacterTuning> {
  const merged = { ...(await getTuning()), ...knobs };
  const [row] = await db
    .insert(characterTuning)
    .values({ id: 1, ...merged, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: characterTuning.id,
      set: {
        maxDist: merged.maxDist,
        k: merged.k,
        pruneK: merged.pruneK,
        minAppearances: merged.minAppearances,
        verifyEnabled: merged.verifyEnabled,
        space: merged.space,
        blendWeight: merged.blendWeight,
        updatedAt: sql`now()`
      }
    })
    .returning();
  return row!;
}
