import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { put } from '@vercel/blob';
import { auth, isOwner } from '@/lib/auth';
import { db } from '@/lib/db/client';
import { captions, descriptions, images, tags } from '@/lib/db/schema';
import { enrichImage } from '@/lib/enrichment';
import { slugify } from '@/lib/slug';
import { uniquifySlug } from '@/lib/db/queries/slugs';
import { getImageBySlug, listImages } from '@/lib/db/queries/images';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get('limit') ?? '24');
  const offset = Number(url.searchParams.get('offset') ?? '0');
  const tagsFilter = url.searchParams.getAll('tag').filter(Boolean);

  const rows = await listImages({ limit, offset, tags: tagsFilter });
  return NextResponse.json({ images: rows });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!isOwner(session)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const form = await req.formData();
  const file = form.get('file');
  const manualCaption = (form.get('manual_caption') as string | null)?.trim() || undefined;

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 });
  }
  const mime = file.type;
  if (!ALLOWED_MIME.has(mime)) {
    return NextResponse.json({ error: `unsupported mime: ${mime}` }, { status: 415 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // Upload to Vercel Blob first -- we want the URL persisted even if enrichment fails.
  const blobKey = `images/${crypto.randomUUID()}-${safeName(file.name)}`;
  const blob = await put(blobKey, buffer, {
    access: 'public',
    contentType: mime,
    addRandomSuffix: false
  });

  // Reserve the row with a placeholder slug. We'll replace it with the real
  // caption-derived slug after enrichment succeeds.
  const placeholderSlug = `img-${blob.pathname.split('/').pop()!.slice(0, 32)}`;
  const [row] = await db
    .insert(images)
    .values({
      slug: placeholderSlug,
      blobUrl: blob.url,
      blobKey: blob.pathname,
      mime,
      ownerId: session!.user!.githubId!,
      manualCaption: manualCaption ?? null
    })
    .returning();

  if (!row) {
    return NextResponse.json({ error: 'failed to create image row' }, { status: 500 });
  }

  // Run the synchronous enrichment. On failure we leave the image row with its
  // placeholder slug so the owner can retry/edit -- better than losing the upload.
  let enrichment;
  try {
    enrichment = await enrichImage(buffer, mime, manualCaption);
  } catch (err) {
    console.error('enrichment failed', err);
    return NextResponse.json(
      { error: 'enrichment failed', imageId: row.id, message: String(err) },
      { status: 502 }
    );
  }

  // Persist captions: 3 AI variants, plus a manual variant-4 if provided.
  const capRows = enrichment.captions.map((c, i) => ({
    imageId: row.id,
    variant: i + 1,
    text: c.text,
    provider: c.provider,
    model: c.model,
    isSlugSource: i === 0 && !manualCaption,
    locked: false
  }));
  if (manualCaption) {
    capRows.push({
      imageId: row.id,
      variant: 4,
      text: manualCaption,
      provider: 'manual',
      model: 'manual',
      isSlugSource: true,
      locked: true
    });
  }
  if (capRows.length > 0) await db.insert(captions).values(capRows);

  if (enrichment.descriptions.length > 0) {
    await db.insert(descriptions).values(
      enrichment.descriptions.map((d, i) => ({
        imageId: row.id,
        variant: i + 1,
        text: d.text,
        provider: d.provider,
        model: d.model,
        locked: false
      }))
    );
  }

  if (enrichment.tags.length > 0) {
    await db
      .insert(tags)
      .values(
        enrichment.tags.map((t) => ({
          imageId: row.id,
          tag: t.tag,
          source: t.source,
          confidence: t.confidence ?? null,
          provider: t.provider,
          model: t.model
        }))
      )
      .onConflictDoNothing();
  }

  // Generate slug from whichever caption is the slug source.
  const slugSource = manualCaption ?? enrichment.captions[0]?.text ?? placeholderSlug;
  const base = slugify(slugSource) || placeholderSlug;
  const finalSlug = await uniquifySlug(base, row.id);
  if (finalSlug !== placeholderSlug) {
    await db.update(images).set({ slug: finalSlug }).where(eq(images.id, row.id));
  }

  const full = await getImageBySlug(finalSlug);
  return NextResponse.json({ image: full }, { status: 201 });
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 64);
}
