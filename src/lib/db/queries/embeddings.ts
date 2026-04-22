import { sql } from 'drizzle-orm';
import { db } from '../client';
import { embeddings } from '../schema';

export type EmbeddingKind = 'image' | 'caption' | 'combined';

export async function upsertEmbedding(params: {
  imageId: number;
  kind: EmbeddingKind;
  vec: number[];
  provider: string;
  model: string;
}): Promise<void> {
  await db
    .insert(embeddings)
    .values({
      imageId: params.imageId,
      kind: params.kind,
      vec: params.vec,
      provider: params.provider,
      model: params.model
    })
    .onConflictDoUpdate({
      target: [embeddings.imageId, embeddings.kind],
      set: {
        vec: params.vec,
        provider: params.provider,
        model: params.model
      }
    });
}

export type VectorMatch = { imageId: number; distance: number };

// pgvector's <=> operator returns cosine distance (lower is closer; 0 means
// identical direction). We cast the driver param via `::vector` because
// @vercel/postgres can't infer the parameter type on its own.
export async function searchByVector(
  vec: number[],
  opts: { limit?: number; kind?: EmbeddingKind } = {}
): Promise<VectorMatch[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 24), 1), 100);
  const kind = opts.kind ?? 'caption';
  const vecLiteral = `[${vec.join(',')}]`;
  const res = await db.execute<{ image_id: number; distance: number }>(sql`
    SELECT image_id, vec <=> ${vecLiteral}::vector AS distance
    FROM embeddings
    WHERE kind = ${kind}
    ORDER BY distance ASC
    LIMIT ${limit}
  `);
  return res.rows.map((r) => ({ imageId: Number(r.image_id), distance: Number(r.distance) }));
}

// Finds the nearest neighbors to the given image by embedding distance. Uses a
// self-join so the source vector stays in Postgres -- no round trip to fetch
// and then re-send it. Returns empty if the source image has no embedding of
// the requested kind.
export async function getNeighborsByImageId(
  imageId: number,
  opts: { limit?: number; kind?: EmbeddingKind } = {}
): Promise<VectorMatch[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 6), 1), 50);
  const kind = opts.kind ?? 'caption';
  const res = await db.execute<{ image_id: number; distance: number }>(sql`
    SELECT e2.image_id, e2.vec <=> e1.vec AS distance
    FROM embeddings e1
    JOIN embeddings e2
      ON e2.kind = e1.kind AND e2.image_id <> e1.image_id
    WHERE e1.image_id = ${imageId} AND e1.kind = ${kind}
    ORDER BY distance ASC
    LIMIT ${limit}
  `);
  return res.rows.map((r) => ({ imageId: Number(r.image_id), distance: Number(r.distance) }));
}
