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
    SELECT id, image_id, label, description, blob_url, box, vec::text AS vec
    FROM character_crops
    ORDER BY id
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

export async function countCharacterCrops(): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM character_crops`);
  return Number(res.rows?.[0]?.n ?? 0);
}
