import { eq, sql } from 'drizzle-orm';
import { db } from '../client';
import { characterCrops, type NewCharacterCrop } from '../schema';

// EVIDENCE / working data: the figures detected + cropped from images, each
// with its embedded description. Produced by the characters.detect job and
// consumed by the clustering census. Not a projection -- regenerable by
// re-running detection.

const EMBED_DIMENSIONS = 1536;

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
  vec: number[];
};

// Every crop with its vector, for clustering. pgvector returns the vector as a
// bracketed string; parse it once here. Ordered by id for deterministic runs.
// Crops of images that have since been archived or marked NSFW are excluded:
// the detect handler skips hidden images so they never seed a character, and
// this keeps a crop made while an image was public from leaking back into the
// census (and onto the public /characters pages) after the image is hidden.
export async function allCropVectors(): Promise<CropVector[]> {
  const res = await db.execute<{
    id: number;
    image_id: number;
    label: string;
    description: string;
    blob_url: string;
    box: { left: number; top: number; width: number; height: number };
    vec: string;
  }>(sql`
    SELECT cc.id, cc.image_id, cc.label, cc.description, cc.blob_url, cc.box, cc.vec::text AS vec
    FROM character_crops cc
    JOIN images i ON i.id = cc.image_id
    WHERE i.archived_at IS NULL AND i.is_nsfw = false
    ORDER BY cc.id
  `);
  return res.rows.map((r) => {
    const inner = r.vec.startsWith('[') ? r.vec.slice(1, -1) : r.vec;
    return {
      cropId: Number(r.id),
      imageId: Number(r.image_id),
      label: r.label,
      description: r.description,
      blobUrl: r.blob_url,
      box: r.box,
      vec: inner.split(',').map(Number)
    };
  });
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

export async function countCharacterCrops(): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM character_crops`);
  return Number(res.rows?.[0]?.n ?? 0);
}
