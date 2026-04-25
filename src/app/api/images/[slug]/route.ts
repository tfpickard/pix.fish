import { NextResponse } from 'next/server';
import type { Session } from 'next-auth';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { del } from '@vercel/blob';
import { auth, canEdit, isSiteAdmin } from '@/lib/auth';
import { db } from '@/lib/db/client';
import { captions, descriptions, images, tags, type Image } from '@/lib/db/schema';
import { getImageBySlug } from '@/lib/db/queries/images';
import { lookupRedirect, pushSlugToHistory, uniquifySlug } from '@/lib/db/queries/slugs';
import { slugify } from '@/lib/slug';
import { emit } from '@/lib/webhooks/emit';

export const runtime = 'nodejs';

// Slugs are unique per (owner_id, slug), so a bare /api/images/<slug> is
// ambiguous when two users share the same slug. Resolve by preferring the
// requesting user's row -- they are almost always editing their own
// image. Site admins may need to moderate any user's image with that
// slug, so fall back to a global lookup with admin tiebreak (matches the
// public legacy /<slug> page resolution).
async function resolveSlugForMutation(
  session: Session | null,
  slug: string
): Promise<Image | null> {
  const userId = session?.user?.id ?? session?.user?.githubId;
  if (userId) {
    const [own] = await db
      .select()
      .from(images)
      .where(and(eq(images.slug, slug), eq(images.ownerId, userId)))
      .limit(1);
    if (own) return own;
  }
  if (!isSiteAdmin(session)) return null;
  // Admin moderation hatch: pick the site admin's row if it exists, else
  // the oldest match across all users.
  const adminId = process.env.OWNER_GITHUB_ID;
  if (adminId) {
    const [hit] = await db
      .select()
      .from(images)
      .where(and(eq(images.slug, slug), eq(images.ownerId, adminId)))
      .limit(1);
    if (hit) return hit;
  }
  const [fallback] = await db
    .select()
    .from(images)
    .where(eq(images.slug, slug))
    .orderBy(asc(images.id))
    .limit(1);
  return fallback ?? null;
}

export async function GET(req: Request, ctx: { params: { slug: string } }) {
  const slug = ctx.params.slug;
  const img = await getImageBySlug(slug);
  if (img) return NextResponse.json({ image: img });

  const redirectTo = await lookupRedirect(slug);
  if (redirectTo) {
    // 301 to the canonical slug. The owner_id from lookupRedirect is
    // available for routing to /u/<handle>/<slug>; here we just keep the
    // legacy /api/images/<slug> shape since callers of this API endpoint
    // historically build URLs from the response, not the redirect Location.
    return NextResponse.redirect(new URL(`/api/images/${redirectTo.slug}`, req.url), 301);
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
  const img = await resolveSlugForMutation(session, ctx.params.slug);
  if (!img) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  if (!canEdit(session, img.ownerId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await req.json()) as PatchBody;

  // Captions. Track which caption the request is promoting to slug source so
  // we pick the *requested* one rather than re-picking the first-by-variant,
  // which would silently fail the common single-toggle request shape.
  let requestedSlugSourceId: number | null = null;
  if (body.captions?.length) {
    for (const upd of body.captions) {
      const fields: Record<string, unknown> = {};
      if (typeof upd.text === 'string') fields.text = upd.text;
      if (typeof upd.locked === 'boolean') fields.locked = upd.locked;
      if (typeof upd.is_slug_source === 'boolean') {
        fields.isSlugSource = upd.is_slug_source;
        if (upd.is_slug_source) requestedSlugSourceId = upd.id;
      }
      if (Object.keys(fields).length === 0) continue;
      await db
        .update(captions)
        .set(fields)
        .where(and(eq(captions.id, upd.id), eq(captions.imageId, img.id)));
    }

    if (requestedSlugSourceId !== null) {
      // Enforce single slug source: unflag everyone except the requested one.
      await db
        .update(captions)
        .set({ isSlugSource: false })
        .where(and(eq(captions.imageId, img.id), ne(captions.id, requestedSlugSourceId)));

      const [newSlugSource] = await db
        .select()
        .from(captions)
        .where(and(eq(captions.id, requestedSlugSourceId), eq(captions.imageId, img.id)))
        .limit(1);

      // If slug was not explicitly changed in this request, regenerate from new source.
      if (newSlugSource && body.slug === undefined) {
        const base = slugify(newSlugSource.text) || img.slug;
        if (base !== img.slug) {
          const newSlug = await uniquifySlug(base, img.ownerId, img.id);
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
    // Stored tags are lowercase; normalize removes to match (adds already are).
    const toRemove = body.tags.remove.map((t) => t.toLowerCase());
    await db
      .delete(tags)
      .where(and(eq(tags.imageId, img.id), inArray(tags.tag, toRemove)));
  }

  // Explicit slug change.
  if (typeof body.slug === 'string' && body.slug.trim()) {
    const base = slugify(body.slug) || img.slug;
    if (base !== img.slug) {
      const newSlug = await uniquifySlug(base, img.ownerId, img.id);
      await pushSlugToHistory(img.id, img.slug);
      await db.update(images).set({ slug: newSlug }).where(eq(images.id, img.id));
    }
  }

  const [refreshedRow] = await db.select().from(images).where(eq(images.id, img.id)).limit(1);
  const fresh = refreshedRow ? await getImageBySlug(refreshedRow.slug) : null;

  if (fresh) {
    await emit('image.updated', {
      image: {
        id: fresh.id,
        slug: fresh.slug,
        blobUrl: fresh.blobUrl,
        width: fresh.width,
        height: fresh.height,
        takenAt: fresh.takenAt ? fresh.takenAt.toISOString() : null,
        uploadedAt: fresh.uploadedAt.toISOString()
      },
      captions: fresh.captions.map((c) => ({
        variant: c.variant,
        text: c.text,
        isSlugSource: c.isSlugSource
      })),
      tags: fresh.tags.map((t) => ({
        tag: t.tag,
        source: t.source as 'taxonomy' | 'freeform',
        confidence: t.confidence
      }))
    });
  }

  return NextResponse.json({ image: fresh });
}

export async function DELETE(_req: Request, ctx: { params: { slug: string } }) {
  const session = await auth();
  const img = await resolveSlugForMutation(session, ctx.params.slug);
  if (!img) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  if (!canEdit(session, img.ownerId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  // Delete the DB row first. Captions/descriptions/tags/embeddings cascade via
  // FKs; slug_history is an array column on the same row. If blob cleanup below
  // fails we'd rather have an orphaned blob than a dangling row that still
  // appears in the gallery.
  await db.delete(images).where(eq(images.id, img.id));

  // Best-effort blob cleanup. `del` accepts the pathname or full URL. We store
  // the pathname in blob_key. A missing-blob 404 is fine; log and move on.
  try {
    await del(img.blobKey);
  } catch (err) {
    console.error('blob delete failed for image', img.id, img.blobKey, err);
  }

  return new NextResponse(null, { status: 204 });
}
