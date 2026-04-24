import { sql } from 'drizzle-orm';
import { db } from '../client';
import { galleryConfig } from '../schema';
import {
  DEFAULT_SHUFFLE_PERIOD,
  DEFAULT_SORT,
  isShufflePeriod,
  isSortMode,
  type ShufflePeriod,
  type SortMode
} from '../../sort/types';

export type GalleryDefaults = {
  defaultSort: SortMode;
  defaultShufflePeriod: ShufflePeriod;
};

const KEY_DEFAULT_SORT = 'default_sort';
const KEY_DEFAULT_SHUFFLE = 'default_shuffle_period';

// Single SELECT, fall back to compiled-in defaults for any row the owner
// hasn't set yet. Soft-fails to defaults if the table itself is missing
// (pre-migration environments) so the gallery still renders.
export async function getGalleryDefaults(): Promise<GalleryDefaults> {
  try {
    const rows = await db.select().from(galleryConfig);
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const rawSort = byKey.get(KEY_DEFAULT_SORT);
    const rawPeriod = byKey.get(KEY_DEFAULT_SHUFFLE);
    return {
      defaultSort: isSortMode(rawSort) ? rawSort : DEFAULT_SORT,
      defaultShufflePeriod: isShufflePeriod(rawPeriod) ? rawPeriod : DEFAULT_SHUFFLE_PERIOD
    };
  } catch {
    return { defaultSort: DEFAULT_SORT, defaultShufflePeriod: DEFAULT_SHUFFLE_PERIOD };
  }
}

export async function setGalleryDefault(key: string, value: string): Promise<void> {
  await db
    .insert(galleryConfig)
    .values({ key, value })
    .onConflictDoUpdate({
      target: galleryConfig.key,
      set: { value, updatedAt: sql`now()` }
    });
}

export const GALLERY_KEYS = {
  defaultSort: KEY_DEFAULT_SORT,
  defaultShufflePeriod: KEY_DEFAULT_SHUFFLE
} as const;
