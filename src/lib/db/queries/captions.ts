import { asc, inArray, sql } from 'drizzle-orm';
import { db } from '../client';
import { captions, images } from '../schema';

export type CaptionSnippet = { slug: string; caption: string };

// For a set of image ids, return each image's slug + its lead caption
// (slug-source first, else lowest variant). Used by the evolution loop to build
// neighbour RAG context for an amendment without hydrating full image rows.
export async function firstCaptionsByImageIds(
  ids: number[]
): Promise<Map<number, CaptionSnippet>> {
  const out = new Map<number, CaptionSnippet>();
  if (ids.length === 0) return out;

  const imgs = await db
    .select({ id: images.id, slug: images.slug })
    .from(images)
    .where(inArray(images.id, ids));

  const caps = await db
    .select({ imageId: captions.imageId, text: captions.text })
    .from(captions)
    .where(inArray(captions.imageId, ids))
    .orderBy(asc(captions.imageId), sql`${captions.isSlugSource} DESC`, asc(captions.variant));

  const lead = new Map<number, string>();
  for (const c of caps) if (!lead.has(c.imageId)) lead.set(c.imageId, c.text);

  for (const im of imgs) {
    out.set(im.id, { slug: im.slug, caption: lead.get(im.id) ?? '' });
  }
  return out;
}
