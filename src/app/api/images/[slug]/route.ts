import { NextResponse } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { auth, isOwner } from '@/lib/auth';
import { db } from '@/lib/db/client';
import { captions, descriptions, images, tags } from '@/lib/db/schema';
import { getImageBySlug } from '@/lib/db/queries/images';
import { lookupRedirect, pushSlugToHistory, uniquifySlug } from '@/lib/db/queries/slugs';
import { slugify } from '@/lib/slug';

export const runtime = 'nodejs';

export async function GET(req: Request, ctx: { params: { slug: string } }) {
  const slug = ctx.params.slug;
  const img = await getImageBySlug(slug);
  if (img) return NextResponse.json({ image: img });

  const redirectTo = await lookupRedirect(slug);
  if (redirectTo) {
    return NextResponse.json({ redirect: redirectTo }, { status: 301 });
  }
  return NextResponse.json({ error: 'not found' }, { status: 404 });
}

type PatchBody = {
  slug?: string;
  captions?: Array<{ id: number; text?: string; locked?: boolean; is_slug_source?: boolean }>;
  descriptions?: Array<{ id: number; text?: string; locked?: boolean }>;
  tags?: { add?: string[]; remove?: string[] };
};

export async function PATCH(req: Request, ctx: { params: { slug: string } }) {
  const session = await auth();
  if (!isOwner(session)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const [img] = await db.select().from(images).where(eq(images.slug, ctx.params.slug)).limit(1);
  if (!img) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const body = (await req.json()) as PatchBody;

  // Captions.
  if (body.captions?.length) {
    for (const upd of body.captions) {
      const fields: Record<string, unknown> = {};
      if (typeof upd.text === 'string') fields.text = upd.text;
      if (typeof upd.locked === 'boolean') fields.locked = upd.locked;
      if (typeof upd.is_slug_source === 'boolean') fields.isSlugSource = upd.is_slug_source;
      if (Object.keys(fields).length === 0) continue;
      await db
        .update(captions)
        .set(fields)
        .where(and(eq(captions.id, upd.id), eq(captions.imageId, img.id)));
    }

    // Enforce single slug source: if any caption is flagged, unflag the rest.
    const [newSlugSource] = await db
      .select()
      .from(captions)
      .where(and(eq(captions.imageId, img.id), eq(captions.isSlugSource, true)))
      .orderBy(captions.variant)
      .limit(1);

    if (newSlugSource) {
      await db
        .update(captions)
        .set({ isSlugSource: false })
        .where(and(eq(captions.imageId, img.id), eq(captions.isSlugSource, true)));
      await db
        .update(captions)
        .set({ isSlugSource: true })
        .where(and(eq(captions.id, newSlugSource.id)));

      // If slug was not explicitly changed in this request, regenerate from new source.
      if (body.slug === undefined) {
        const base = slugify(newSlugSource.text) || img.slug;
        if (base !== img.slug) {
          const newSlug = await uniquifySlug(base, img.id);
          await pushSlugToHistory(img.id, img.slug);
          await db.update(images).set({ slug: newSlug }).where(eq(images.id, img.id));
        }
      }
    }
  }

  // Descriptions.
  if (body.descriptions?.length) {
    for (const upd of body.descriptions) {
      const fields: Record<string, unknown> = {};
      if (typeof upd.text === 'string') fields.text = upd.text;
      if (typeof upd.locked === 'boolean') fields.locked = upd.locked;
      if (Object.keys(fields).length === 0) continue;
      await db
        .update(descriptions)
        .set(fields)
        .where(and(eq(descriptions.id, upd.id), eq(descriptions.imageId, img.id)));
    }
  }

  // Tags.
  if (body.tags?.add?.length) {
    await db
      .insert(tags)
      .values(
        body.tags.add.map((t) => ({
          imageId: img.id,
          tag: t.toLowerCase(),
          source: 'freeform' as const
        }))
      )
      .onConflictDoNothing();
  }
  if (body.tags?.remove?.length) {
    await db
      .delete(tags)
      .where(and(eq(tags.imageId, img.id), inArray(tags.tag, body.tags.remove)));
  }

  // Explicit slug change.
  if (typeof body.slug === 'string' && body.slug.trim()) {
    const base = slugify(body.slug) || img.slug;
    if (base !== img.slug) {
      const newSlug = await uniquifySlug(base, img.id);
      await pushSlugToHistory(img.id, img.slug);
      await db.update(images).set({ slug: newSlug }).where(eq(images.id, img.id));
    }
  }

  const [refreshedRow] = await db.select().from(images).where(eq(images.id, img.id)).limit(1);
  const fresh = refreshedRow ? await getImageBySlug(refreshedRow.slug) : null;
  return NextResponse.json({ image: fresh });
}
