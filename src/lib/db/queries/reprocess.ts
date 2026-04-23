import { and, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { db } from '../client';
import { captions, descriptions, embeddings, images, tags } from '../schema';
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
    const rows = await db
      .selectDistinct({ imageId: table.imageId })
      .from(table)
      .where(or(ne(table.provider, provider), ne(table.model, model)));
    return rows.map((r) => r.imageId).filter((n): n is number => typeof n === 'number');
  }
  const rows = await db
    .select({ imageId: embeddings.imageId })
    .from(embeddings)
    .where(
      and(
        eq(embeddings.kind, 'caption'),
        or(ne(embeddings.provider, provider), ne(embeddings.model, model))
      )
    );
  return rows.map((r) => r.imageId);
}

export async function allImageIds(): Promise<number[]> {
  const rows = await db.select({ id: images.id }).from(images);
  return rows.map((r) => r.id);
}

// Delete existing rows for the given field on the given image so the
// reprocess handler can re-insert fresh ones. embeddings are upserted, not
// deleted; captions/descriptions are replaced; tags are truncated per-image.
export async function deleteField(imageId: number, field: ProviderField): Promise<void> {
  if (field === 'captions') {
    // Preserve the manual variant (variant=4, locked) so owner edits survive.
    await db
      .delete(captions)
      .where(and(eq(captions.imageId, imageId), inArray(captions.variant, [1, 2, 3])));
  } else if (field === 'descriptions') {
    await db
      .delete(descriptions)
      .where(and(eq(descriptions.imageId, imageId), inArray(descriptions.variant, [1, 2, 3])));
  } else if (field === 'tags') {
    await db.delete(tags).where(eq(tags.imageId, imageId));
  }
  // embeddings: no-op, upsertEmbedding handles replacement.
}
