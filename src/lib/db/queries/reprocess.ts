import { sql } from 'drizzle-orm';
import { db } from '../client';
import { captions, descriptions, images, tags } from '../schema';
import type { ProviderField } from '@/lib/ai';

export type StaleCount = { field: ProviderField; count: number };

// For a given field + current (provider, model) tuple, count the images that
// have at least one row on that field not matching the current routing. For
// embeddings the table is different (one row per image) and the check is
// against the embeddings row's provider/model with kind='caption'.
export async function staleCount(
  field: ProviderField,
  provider: string,
  model: string
): Promise<number> {
  if (field === 'captions' || field === 'descriptions' || field === 'tags') {
    const table = field === 'captions' ? captions : field === 'descriptions' ? descriptions : tags;
    const res = await db.execute<{ count: number }>(sql`
      SELECT count(DISTINCT image_id)::int AS count
      FROM ${table}
      WHERE (provider IS DISTINCT FROM ${provider}) OR (model IS DISTINCT FROM ${model})
    `);
    return Number(res.rows[0]?.count ?? 0);
  }
  // embeddings
  const res = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count
    FROM embeddings
    WHERE kind = 'caption'
      AND ((provider IS DISTINCT FROM ${provider}) OR (model IS DISTINCT FROM ${model}))
  `);
  return Number(res.rows[0]?.count ?? 0);
}

// Collect the imageIds that need work for a given field under current config.
export async function staleImageIds(
  field: ProviderField,
  provider: string,
  model: string
): Promise<number[]> {
  if (field === 'captions' || field === 'descriptions' || field === 'tags') {
    const table = field === 'captions' ? captions : field === 'descriptions' ? descriptions : tags;
    // IS DISTINCT FROM treats NULL as a value; using `ne()` would drop rows
    // whose provider/model is NULL (NULL <> 'x' is NULL, not true) and
    // disagree with staleCount, which uses IS DISTINCT FROM.
    const rows = await db.execute<{ image_id: number }>(sql`
      SELECT DISTINCT image_id FROM ${table}
      WHERE (provider IS DISTINCT FROM ${provider}) OR (model IS DISTINCT FROM ${model})
    `);
    return rows.rows.map((r) => Number(r.image_id));
  }
  const rows = await db.execute<{ image_id: number }>(sql`
    SELECT image_id FROM embeddings
    WHERE kind = 'caption'
      AND ((provider IS DISTINCT FROM ${provider}) OR (model IS DISTINCT FROM ${model}))
  `);
  return rows.rows.map((r) => Number(r.image_id));
}

export async function allImageIds(): Promise<number[]> {
  const rows = await db.select({ id: images.id }).from(images);
  return rows.map((r) => r.id);
}

