import { sql } from 'drizzle-orm';
import { db } from '../client';
import { embeddings } from '../schema';

export type EmbeddingKind = 'image' | 'caption' | 'combined';

// Must match the `dimensions` argument on the embeddings.vec column in
// schema.ts. A mismatch at this boundary is a config bug -- fail fast with a
// clear error rather than letting Postgres throw a less obvious pgvector one.
const EMBED_DIMENSIONS = 1536;

function assertVector(vec: number[]): void {
  if (!Array.isArray(vec) || vec.length !== EMBED_DIMENSIONS) {
    throw new Error(
      `embedding vector has ${Array.isArray(vec) ? vec.length : typeof vec} dims; expected ${EMBED_DIMENSIONS}.`
    );
  }
  if (!vec.every((n) => Number.isFinite(n))) {
    throw new Error('embedding vector contains non-finite numbers.');
  }
}

export async function upsertEmbedding(params: {
  imageId: number;
  kind: EmbeddingKind;
  vec: number[];
  provider: string;
  model: string;
}): Promise<void> {
  assertVector(params.vec);
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
  assertVector(vec);
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
// Fetch (imageId, vec) for every caption embedding. Used by the UMAP job;
// pgvector returns the vector as a bracketed string which we parse once here
// so downstream callers don't have to know about the wire format.
export async function allCaptionVectors(): Promise<{ imageId: number; vec: number[] }[]> {
  const res = await db.execute<{ image_id: number; vec: string }>(sql`
    SELECT image_id, vec::text AS vec FROM embeddings WHERE kind = 'caption'
  `);
  return res.rows.map((r) => {
    const inner = r.vec.startsWith('[') ? r.vec.slice(1, -1) : r.vec;
    const arr = inner.split(',').map(Number);
    return { imageId: Number(r.image_id), vec: arr };
  });
}

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
