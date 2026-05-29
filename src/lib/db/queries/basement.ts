import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../client';
import { captions, descriptions, images, tags, users } from '../schema';
import type { Image } from '../schema';
import { hydrateImages, type ImageWithRelations } from './images';

// Basement-scoped query helpers. These are the ONLY paths that return
// rows with basement=true. They are only called after the server has
// confirmed the pf_basement cookie is set -- the gate is enforced by
// the callers (/basement page, /api/basement/images), not here.
//
// By keeping basement queries separate from the main listImages/countImages
// path we can confirm the gate is applied and audited independently.

// Lists all basement images newest-first. Caller has already verified the
// unlock cookie -- this query imposes no visibility filter of its own so
// it's intentionally ONLY reachable via the gated /basement route.
export async function listBasementImages(opts: {
  limit?: number;
  offset?: number;
}): Promise<ImageWithRelations[]> {
  const limit = Math.min(Math.max(Number(opts.limit) | 0 || 24, 1), 100);
  const offset = Math.max(Number(opts.offset) | 0 || 0, 0);
  const rows = await db
    .select()
    .from(images)
    .where(eq(images.basement, true))
    .orderBy(desc(images.uploadedAt), desc(images.id))
    .limit(limit)
    .offset(offset);
  return hydrateImages(rows);
}

export async function countBasementImages(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(images)
    .where(eq(images.basement, true));
  return row?.n ?? 0;
}

// Single basement image lookup by handle + slug. Used by the /basement/[slug]
// detail route. Returns null when the image is not marked basement=true so
// an unlocked visitor can't reach a non-basement image via the basement route.
export async function getBasementImageByHandleAndSlug(
  handle: string,
  slug: string
): Promise<ImageWithRelations | null> {
  const [row] = await db
    .select({ image: images })
    .from(images)
    .innerJoin(users, eq(users.id, images.ownerId))
    .where(and(eq(users.handle, handle), eq(images.slug, slug), eq(images.basement, true)))
    .limit(1);
  if (!row) return null;
  return buildBasementImageRelations(row.image);
}

// Lookup by id only -- used by the admin basement-flag toggle to confirm
// the row exists before flipping it. Does not filter by basement=true
// because it's an admin tool that can mark or unmark any image.
export async function getImageById(id: number): Promise<Image | null> {
  const [row] = await db.select().from(images).where(eq(images.id, id)).limit(1);
  return row ?? null;
}

// Set or unset the basement flag on a single image.
export async function setImageBasement(id: number, basement: boolean): Promise<Image | null> {
  const [row] = await db
    .update(images)
    .set({ basement })
    .where(eq(images.id, id))
    .returning();
  return row ?? null;
}

async function buildBasementImageRelations(img: Image): Promise<ImageWithRelations> {
  const [capRows, descRows, tagRows] = await Promise.all([
    db.select().from(captions).where(eq(captions.imageId, img.id)).orderBy(asc(captions.variant)),
    db
      .select()
      .from(descriptions)
      .where(eq(descriptions.imageId, img.id))
      .orderBy(asc(descriptions.variant)),
    db.select().from(tags).where(eq(tags.imageId, img.id)).orderBy(asc(tags.tag))
  ]);
  return {
    ...img,
    captions: capRows.map((c) => ({
      id: c.id,
      variant: c.variant,
      text: c.text,
      isSlugSource: c.isSlugSource,
      locked: c.locked
    })),
    descriptions: descRows.map((d) => ({
      id: d.id,
      variant: d.variant,
      text: d.text,
      locked: d.locked
    })),
    tags: tagRows.map((t) => ({
      id: t.id,
      tag: t.tag,
      source: t.source,
      confidence: t.confidence
    }))
  };
}
