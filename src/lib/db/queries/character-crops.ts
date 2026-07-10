import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../client';
import { characterCrops, type NewCharacterCrop } from '../schema';

// EVIDENCE / working data: the figures detected + cropped from images, each
// with its embedded description. Produced by the characters.detect job and
// consumed by the clustering census. Not a projection -- regenerable by
// re-running detection.

const EMBED_DIMENSIONS = 1536; // text vec
const IMAGE_EMBED_DIMENSIONS = 1024; // visual vec (Voyage multimodal-3.5)

export async function insertCharacterCrop(input: NewCharacterCrop): Promise<number> {
  if (!Array.isArray(input.vec) || input.vec.length !== EMBED_DIMENSIONS) {
    throw new Error(`character crop vec has wrong dims; expected ${EMBED_DIMENSIONS}.`);
  }
  const [row] = await db.insert(characterCrops).values(input).returning({ id: characterCrops.id });
  return row!.id;
}

export type CropVector = {
  cropId: number;
  imageId: number;
  label: string;
  description: string;
  blobUrl: string;
  box: { left: number; top: number; width: number; height: number };
  vec: number[]; // text-description embedding (1536-d)
  vecImage: number[] | null; // visual embedding (1024-d), null if not yet computed
};

// pgvector returns a bracketed string like "[0.1,0.2,...]"; parse to number[].
function parseVec(raw: string | null): number[] | null {
  if (!raw) return null;
  const inner = raw.startsWith('[') ? raw.slice(1, -1) : raw;
  if (inner.length === 0) return null;
  return inner.split(',').map(Number);
}

// Every crop with both vectors, for clustering. Ordered by id for deterministic
// runs. NSFW crops are INCLUDED: a character's NSFW appearances are part of their
// identity, so they must inform clustering and the synthesized dossier. Only
// archived (removed-from-circulation) images are excluded. Public leakage is
// prevented at the display layer -- listVisibleCharacters / the detail page
// derive the shown crops + canonical headshot from visible appearances per
// viewer, so an NSFW crop never reaches an opted-out visitor.
export async function allCropVectors(): Promise<CropVector[]> {
  const res = await db.execute<{
    id: number;
    image_id: number;
    label: string;
    description: string;
    blob_url: string;
    box: { left: number; top: number; width: number; height: number };
    vec: string;
    vec_image: string | null;
  }>(sql`
    SELECT cc.id, cc.image_id, cc.label, cc.description, cc.blob_url, cc.box,
           cc.vec::text AS vec, cc.vec_image::text AS vec_image
    FROM character_crops cc
    JOIN images i ON i.id = cc.image_id
    WHERE i.archived_at IS NULL
    ORDER BY cc.id
  `);
  return res.rows.map((r) => ({
    cropId: Number(r.id),
    imageId: Number(r.image_id),
    label: r.label,
    description: r.description,
    blobUrl: r.blob_url,
    box: r.box,
    vec: parseVec(r.vec) ?? [],
    vecImage: parseVec(r.vec_image)
  }));
}

// Backfill support: set an existing crop's visual vector. Validates the 1024-d
// length, and writes only while vec_image is still NULL -- so a duplicate/
// concurrent backfill job can't re-embed or clobber an existing vector (the
// update simply matches zero rows).
export async function setCropImageVec(
  cropId: number,
  vecImage: number[],
  imageProvider: string,
  imageModel: string
): Promise<void> {
  if (!Array.isArray(vecImage) || vecImage.length !== IMAGE_EMBED_DIMENSIONS) {
    throw new Error(`character crop vec_image has wrong dims; expected ${IMAGE_EMBED_DIMENSIONS}.`);
  }
  await db
    .update(characterCrops)
    .set({ vecImage, imageProvider, imageModel })
    .where(and(eq(characterCrops.id, cropId), isNull(characterCrops.vecImage)));
}

// Crops still missing a visual vector (for the backfill job/script), oldest
// first (by id) for a deterministic, stable drain order. Returns id + blobUrl.
export async function cropsMissingImageVec(limit = 10_000): Promise<{ cropId: number; blobUrl: string }[]> {
  const res = await db.execute<{ id: number; blob_url: string }>(sql`
    SELECT cc.id, cc.blob_url FROM character_crops cc
    JOIN images i ON i.id = cc.image_id
    WHERE cc.vec_image IS NULL AND i.archived_at IS NULL
    ORDER BY cc.id
    LIMIT ${Math.trunc(limit)}
  `);
  return res.rows.map((r) => ({ cropId: Number(r.id), blobUrl: r.blob_url }));
}

export async function countCropsForImage(imageId: number): Promise<number> {
  const res = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM character_crops WHERE image_id = ${imageId}`
  );
  return Number(res.rows?.[0]?.n ?? 0);
}

// Re-detection support: clear an image's crops before re-inserting.
export async function deleteCropsForImage(imageId: number): Promise<void> {
  await db.delete(characterCrops).where(eq(characterCrops.imageId, imageId));
}

// Blob keys of an image's crops, for blob cleanup before the image row (and its
// cascading character_crops rows) is deleted. Without this the crop headshots
// stay publicly reachable by URL after a moderation/privacy delete.
export async function cropBlobKeysForImage(imageId: number): Promise<string[]> {
  const rows = await db
    .select({ blobKey: characterCrops.blobKey })
    .from(characterCrops)
    .where(eq(characterCrops.imageId, imageId));
  return rows.map((r) => r.blobKey);
}

// Crops by id (no vector) -- for the mosaic verify pass + census assembly, which
// need the blob URL, image id, description, and box, but not the embedding.
export type CropMeta = {
  cropId: number;
  imageId: number;
  label: string;
  description: string;
  blobUrl: string;
  box: { left: number; top: number; width: number; height: number };
};

export async function cropsByIds(ids: number[]): Promise<CropMeta[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      cropId: characterCrops.id,
      imageId: characterCrops.imageId,
      label: characterCrops.label,
      description: characterCrops.description,
      blobUrl: characterCrops.blobUrl,
      box: characterCrops.box
    })
    .from(characterCrops)
    .where(inArray(characterCrops.id, ids));
  return rows.map((r) => ({
    cropId: r.cropId,
    imageId: r.imageId,
    label: r.label,
    description: r.description,
    blobUrl: r.blobUrl,
    box: r.box
  }));
}

export async function countCharacterCrops(): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM character_crops`);
  return Number(res.rows?.[0]?.n ?? 0);
}
