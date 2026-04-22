import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  captions,
  descriptions,
  images,
  tags,
  type Image
} from '../schema';

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value as number), min), max);
}

export type ImageWithRelations = Image & {
  captions: { id: number; variant: number; text: string; isSlugSource: boolean; locked: boolean }[];
  descriptions: { id: number; variant: number; text: string; locked: boolean }[];
  tags: { id: number; tag: string; source: string; confidence: number | null }[];
};

export async function listImages(opts: {
  limit?: number;
  offset?: number;
  tags?: string[];
}): Promise<ImageWithRelations[]> {
  const limit = clampInt(opts.limit, 24, 1, 100);
  const offset = clampInt(opts.offset, 0, 0, Number.MAX_SAFE_INTEGER);

  let imageRows: Image[];
  if (opts.tags && opts.tags.length > 0) {
    // AND semantics: image must have every requested tag.
    const tagList = opts.tags;
    const matchingIdsSubquery = db
      .select({ id: tags.imageId })
      .from(tags)
      .where(inArray(tags.tag, tagList))
      .groupBy(tags.imageId)
      .having(sql`count(distinct ${tags.tag}) = ${tagList.length}`);
    imageRows = await db
      .select()
      .from(images)
      .where(inArray(images.id, matchingIdsSubquery))
      .orderBy(desc(images.uploadedAt), desc(images.id))
      .limit(limit)
      .offset(offset);
  } else {
    imageRows = await db
      .select()
      .from(images)
      .orderBy(desc(images.uploadedAt), desc(images.id))
      .limit(limit)
      .offset(offset);
  }

  if (imageRows.length === 0) return [];

  const ids = imageRows.map((i) => i.id);
  const [capRows, descRows, tagRows] = await Promise.all([
    db
      .select()
      .from(captions)
      .where(inArray(captions.imageId, ids))
      .orderBy(asc(captions.imageId), asc(captions.variant)),
    db
      .select()
      .from(descriptions)
      .where(inArray(descriptions.imageId, ids))
      .orderBy(asc(descriptions.imageId), asc(descriptions.variant)),
    db.select().from(tags).where(inArray(tags.imageId, ids)).orderBy(asc(tags.tag))
  ]);

  const capByImage = groupBy(capRows, (r) => r.imageId);
  const descByImage = groupBy(descRows, (r) => r.imageId);
  const tagByImage = groupBy(tagRows, (r) => r.imageId);

  return imageRows.map((img) => ({
    ...img,
    captions: (capByImage.get(img.id) ?? []).map((c) => ({
      id: c.id,
      variant: c.variant,
      text: c.text,
      isSlugSource: c.isSlugSource,
      locked: c.locked
    })),
    descriptions: (descByImage.get(img.id) ?? []).map((d) => ({
      id: d.id,
      variant: d.variant,
      text: d.text,
      locked: d.locked
    })),
    tags: (tagByImage.get(img.id) ?? []).map((t) => ({
      id: t.id,
      tag: t.tag,
      source: t.source,
      confidence: t.confidence
    }))
  }));
}

export async function getImageBySlug(slug: string): Promise<ImageWithRelations | null> {
  const [img] = await db.select().from(images).where(eq(images.slug, slug)).limit(1);
  if (!img) return null;
  const [capRows, descRows, tagRows] = await Promise.all([
    db
      .select()
      .from(captions)
      .where(eq(captions.imageId, img.id))
      .orderBy(asc(captions.variant)),
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

export async function countImages(tagsFilter?: string[]): Promise<number> {
  if (tagsFilter && tagsFilter.length > 0) {
    const matchingIdsSubquery = db
      .select({ id: tags.imageId })
      .from(tags)
      .where(inArray(tags.tag, tagsFilter))
      .groupBy(tags.imageId)
      .having(sql`count(distinct ${tags.tag}) = ${tagsFilter.length}`);
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(images)
      .where(inArray(images.id, matchingIdsSubquery));
    return row?.count ?? 0;
  }
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(images);
  return row?.count ?? 0;
}

function groupBy<T, K>(arr: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const item of arr) {
    const k = key(item);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(item);
  }
  return m;
}
