import { and, eq, sql } from 'drizzle-orm';
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
import { DEFAULT_SEARCH_SIM_THRESHOLD } from '../../search/defaults';

// Re-export so existing callers (e.g. /search) can keep importing it
// from gallery-config; the constant itself lives in src/lib/search to
// stay client-safe.
export { DEFAULT_SEARCH_SIM_THRESHOLD };

export type GalleryDefaults = {
  defaultSort: SortMode;
  defaultShufflePeriod: ShufflePeriod;
  // Cosine similarity floor used by /search to drop noisy bottom-of-the
  // -ranking matches. 0 = keep everything pgvector returns; 1 = require
  // an exact-direction match. 0.30 is sane for OpenAI text-embedding-3-
  // small caption embeddings on the current corpus; tune as you go.
  searchSimilarityThreshold: number;
};

const KEY_DEFAULT_SORT = 'default_sort';
const KEY_DEFAULT_SHUFFLE = 'default_shuffle_period';
const KEY_SEARCH_SIM_THRESHOLD = 'search_similarity_threshold';

function parseThreshold(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_SEARCH_SIM_THRESHOLD;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_SEARCH_SIM_THRESHOLD;
  return Math.max(0, Math.min(1, n));
}

// Per-user gallery defaults. Single SELECT, fall back to compiled-in
// defaults for any row the user hasn't set yet. Soft-fails to defaults if
// the table itself is missing (pre-migration environments) so the gallery
// still renders.
export async function getGalleryDefaults(ownerId: string): Promise<GalleryDefaults> {
  try {
    const rows = await db
      .select()
      .from(galleryConfig)
      .where(eq(galleryConfig.ownerId, ownerId));
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const rawSort = byKey.get(KEY_DEFAULT_SORT);
    const rawPeriod = byKey.get(KEY_DEFAULT_SHUFFLE);
    return {
      defaultSort: isSortMode(rawSort) ? rawSort : DEFAULT_SORT,
      defaultShufflePeriod: isShufflePeriod(rawPeriod) ? rawPeriod : DEFAULT_SHUFFLE_PERIOD,
      searchSimilarityThreshold: parseThreshold(byKey.get(KEY_SEARCH_SIM_THRESHOLD))
    };
  } catch {
    return {
      defaultSort: DEFAULT_SORT,
      defaultShufflePeriod: DEFAULT_SHUFFLE_PERIOD,
      searchSimilarityThreshold: DEFAULT_SEARCH_SIM_THRESHOLD
    };
  }
}

export async function setGalleryDefault(
  ownerId: string,
  key: string,
  value: string
): Promise<void> {
  await db
    .insert(galleryConfig)
    .values({ ownerId, key, value })
    .onConflictDoUpdate({
      target: [galleryConfig.ownerId, galleryConfig.key],
      set: { value, updatedAt: sql`now()` }
    });
}

export const GALLERY_KEYS = {
  defaultSort: KEY_DEFAULT_SORT,
  defaultShufflePeriod: KEY_DEFAULT_SHUFFLE,
  searchSimilarityThreshold: KEY_SEARCH_SIM_THRESHOLD
} as const;
