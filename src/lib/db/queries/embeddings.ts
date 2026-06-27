import { sql } from 'drizzle-orm';
import { db } from '../client';
import { embeddings } from '../schema';
import type { NsfwMode } from '@/lib/nsfw';

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
      subjectType: 'image',
      kind: params.kind,
      vec: params.vec,
      provider: params.provider,
      model: params.model
    })
    .onConflictDoUpdate({
      target: [embeddings.imageId, embeddings.kind],
      set: {
        // Re-assert subjectType on update so a row can never drift out of the
        // image-only query filters (the CHECK also forbids a mismatch).
        subjectType: 'image',
        vec: params.vec,
        provider: params.provider,
        model: params.model
      }
    });
}

// Universe: a lore fragment's embedding lives in the same pgvector store as the
// images (subject_type='lore'), so dossiers co-locate in the same space and
// search through the same path. Upsert on (lore_fragment_id, kind) keeps a
// projection rebuild idempotent -- replaying the log re-populates the vector
// from the event payload without an API call.
export async function upsertLoreEmbedding(params: {
  loreFragmentId: number;
  kind: EmbeddingKind;
  vec: number[];
  provider: string;
  model: string;
}): Promise<void> {
  assertVector(params.vec);
  await db
    .insert(embeddings)
    .values({
      loreFragmentId: params.loreFragmentId,
      subjectType: 'lore',
      kind: params.kind,
      vec: params.vec,
      provider: params.provider,
      model: params.model
    })
    .onConflictDoUpdate({
      target: [embeddings.loreFragmentId, embeddings.kind],
      set: {
        // Re-assert subjectType on update so the lore-only query filters can
        // never miss this row (the CHECK also forbids a mismatch).
        subjectType: 'lore',
        vec: params.vec,
        provider: params.provider,
        model: params.model
      }
    });
}

export type LoreVectorMatch = {
  loreFragmentId: number;
  specimenImageId: number;
  distance: number;
};

// Semantic search over clerk-authored lore. Mirrors searchByVector but ranks
// lore fragments instead of images, joining lore_fragments to surface the
// parent specimen. This is what makes a phrase from a generated dossier
// findable in the same embedding space as the captions.
export async function searchLoreByVector(
  vec: number[],
  opts: { limit?: number; order?: 'nearest' | 'farthest' } = {}
): Promise<LoreVectorMatch[]> {
  assertVector(vec);
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 24), 1), 100);
  const vecLiteral = `[${vec.join(',')}]`;
  const direction = opts.order === 'farthest' ? sql`DESC` : sql`ASC`;
  const res = await db.execute<{
    lore_fragment_id: number;
    specimen_image_id: number;
    distance: number;
  }>(sql`
    SELECT e.lore_fragment_id, lf.specimen_image_id, e.vec <=> ${vecLiteral}::vector AS distance
    FROM embeddings e
    JOIN lore_fragments lf ON lf.id = e.lore_fragment_id
    WHERE e.subject_type = 'lore'
    ORDER BY distance ${direction}
    LIMIT ${limit}
  `);
  return res.rows.map((r) => ({
    loreFragmentId: Number(r.lore_fragment_id),
    specimenImageId: Number(r.specimen_image_id),
    distance: Number(r.distance)
  }));
}

// Fetch a single lore fragment's embedding by fragment id. Returns null if the
// fragment has no embedding yet. Parallels getCaptionVector.
export async function getLoreFragmentVector(loreFragmentId: number): Promise<number[] | null> {
  const res = await db.execute<{ vec: string }>(sql`
    SELECT vec::text AS vec FROM embeddings
    WHERE lore_fragment_id = ${loreFragmentId} AND subject_type = 'lore'
    LIMIT 1
  `);
  const row = res.rows[0];
  if (!row) return null;
  const inner = row.vec.startsWith('[') ? row.vec.slice(1, -1) : row.vec;
  return inner.split(',').map(Number);
}

export type VectorMatch = { imageId: number; distance: number };

// Total image rows that currently have a caption embedding. Used by /map
// to flag a stale UMAP projection (`pointCount < this` => recompute hint).
export async function countCaptionEmbeddings(): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM embeddings WHERE kind = 'caption' AND subject_type = 'image'`
  );
  return Number(rows.rows?.[0]?.n ?? 0);
}

// pgvector's <=> operator returns cosine distance (lower is closer; 0 means
// identical direction). We cast the driver param via `::vector` because
// @vercel/postgres can't infer the parameter type on its own.
//
// `order: 'farthest'` walks the same index in reverse and returns the most
// dissimilar rows -- used by antibreed to find the "far territory" of a
// centroid. Caveat: in high-dimensional embedding space many vectors sit at
// near-orthogonal distance (~1.0), so the farthest set can be incoherent.
// Callers that care about coherence should ignore distance and use the
// farthest set only as LLM context, not as a final answer.
export async function searchByVector(
  vec: number[],
  opts: { limit?: number; kind?: EmbeddingKind; order?: 'nearest' | 'farthest'; nsfwMode?: NsfwMode } = {}
): Promise<VectorMatch[]> {
  assertVector(vec);
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 24), 1), 100);
  const kind = opts.kind ?? 'caption';
  const nsfwMode = opts.nsfwMode ?? 'hide';
  const vecLiteral = `[${vec.join(',')}]`;
  const direction = opts.order === 'farthest' ? sql`DESC` : sql`ASC`;
  const nsfwClause =
    nsfwMode === 'only' ? sql`AND i.is_nsfw = true` :
    nsfwMode === 'include' ? sql`` :
    sql`AND i.is_nsfw = false`;
  const res = await db.execute<{ image_id: number; distance: number }>(sql`
    SELECT e.image_id, e.vec <=> ${vecLiteral}::vector AS distance
    FROM embeddings e
    JOIN images i ON i.id = e.image_id
    WHERE e.kind = ${kind} AND e.subject_type = 'image'
    ${nsfwClause}
    ORDER BY distance ${direction}
    LIMIT ${limit}
  `);
  return res.rows.map((r) => ({ imageId: Number(r.image_id), distance: Number(r.distance) }));
}

// Random image slugs drawn from the caption-embedded set -- i.e. the actual
// nodes of the kNN graph -- so a "surprise me" pair is almost always
// connectable. Gated by the visitor's NSFW mode so the same is_nsfw rule that
// scopes the path search also scopes which images we hand back as a seed.
export async function getRandomCaptionImageSlugs(
  count: number,
  nsfwMode: NsfwMode = 'hide'
): Promise<string[]> {
  const limit = Math.min(Math.max(Math.trunc(count), 1), 10);
  const nsfwClause =
    nsfwMode === 'only' ? sql`AND i.is_nsfw = true` :
    nsfwMode === 'include' ? sql`` :
    sql`AND i.is_nsfw = false`;
  const res = await db.execute<{ slug: string }>(sql`
    SELECT i.slug
    FROM embeddings e
    JOIN images i ON i.id = e.image_id
    WHERE e.kind = 'caption' ${nsfwClause}
    ORDER BY random()
    LIMIT ${limit}
  `);
  return res.rows.map((r) => r.slug);
}

// Finds the nearest neighbors to the given image by embedding distance. Uses a
// self-join so the source vector stays in Postgres -- no round trip to fetch
// and then re-send it. Returns empty if the source image has no embedding of
// the requested kind.
// Fetch a single caption embedding by imageId. Returns null if the image
// has no embedding yet (pre-Phase 2 rows, or an upload whose embed failed).
// Used by the public /[slug] page to render a per-image fingerprint viz.
export async function getCaptionVector(imageId: number): Promise<number[] | null> {
  const res = await db.execute<{ vec: string }>(sql`
    SELECT vec::text AS vec FROM embeddings
    WHERE image_id = ${imageId} AND kind = 'caption'
    LIMIT 1
  `);
  const row = res.rows[0];
  if (!row) return null;
  const inner = row.vec.startsWith('[') ? row.vec.slice(1, -1) : row.vec;
  return inner.split(',').map(Number);
}

// Fetch (imageId, vec) for every caption embedding. Used by the UMAP job;
// pgvector returns the vector as a bracketed string which we parse once here
// so downstream callers don't have to know about the wire format.
//
// ORDER BY image_id so the row order is stable run-to-run. Both the entropy
// recompute (seeded pairwise temperature sample) and the manifold handler
// (seeded subsample shuffle) draw deterministic slices from this corpus; an
// unordered scan would pick different vectors each run even with the same
// seed, breaking the stable-layout and reproducible-temperature guarantees.
// No existing caller depends on the prior (unspecified) order.
export async function allCaptionVectors(): Promise<{ imageId: number; vec: number[] }[]> {
  const res = await db.execute<{ image_id: number; vec: string }>(sql`
    SELECT image_id, vec::text AS vec FROM embeddings
    WHERE kind = 'caption' AND subject_type = 'image'
    ORDER BY image_id
  `);
  return res.rows.map((r) => {
    const inner = r.vec.startsWith('[') ? r.vec.slice(1, -1) : r.vec;
    const arr = inner.split(',').map(Number);
    return { imageId: Number(r.image_id), vec: arr };
  });
}

export async function getNeighborsByImageId(
  imageId: number,
  opts: { limit?: number; kind?: EmbeddingKind; order?: 'nearest' | 'farthest' } = {}
): Promise<VectorMatch[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 6), 1), 50);
  const kind = opts.kind ?? 'caption';
  // Cosine distance: 0 = identical direction, 2 = opposite. Nearest uses
  // ASC, farthest DESC. Both queries walk the same pgvector index.
  const direction = opts.order === 'farthest' ? sql`DESC` : sql`ASC`;
  const res = await db.execute<{ image_id: number; distance: number }>(sql`
    SELECT e2.image_id, e2.vec <=> e1.vec AS distance
    FROM embeddings e1
    JOIN embeddings e2
      ON e2.kind = e1.kind AND e2.subject_type = 'image' AND e2.image_id <> e1.image_id
    WHERE e1.image_id = ${imageId} AND e1.kind = ${kind} AND e1.subject_type = 'image'
    ORDER BY distance ${direction}
    LIMIT ${limit}
  `);
  return res.rows.map((r) => ({ imageId: Number(r.image_id), distance: Number(r.distance) }));
}
