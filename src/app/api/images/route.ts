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
  const limit = parseIntParam(url.searchParams.get('limit'), 24);
  const offset = parseIntParam(url.searchParams.get('offset'), 0);
  const tagsFilter = url.searchParams.getAll('tag').filter(Boolean);

  const rows = await listImages({ limit, offset, tags: tagsFilter });
  return NextResponse.json({ images: rows });
}

function parseIntParam(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export async function POST(req: Request) {
  const session = await auth();
  if (!isOwner(session)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const form = await req.formData();
  const file = form.get('file');
  const rawManualCaption = form.get('manual_caption');
  const manualCaption =
    typeof rawManualCaption === 'string' && rawManualCaption.trim()
      ? rawManualCaption.trim()
      : undefined;

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
    // Log full detail server-side; return a generic message to avoid leaking
    // vendor SDK internals (request ids, stack frames, partial prompts).
    console.error('enrichment failed for image', row.id, err);
    return NextResponse.json(
      { error: 'enrichment failed', imageId: row.id },
      { status: 502 }
    );
  }

  // Persist captions + descriptions + tags + slug in a single transaction so
  // a mid-pipeline failure cannot leave the image half-enriched.
  const slugSourceText = manualCaption ?? enrichment.captions[0]?.text ?? placeholderSlug;
  const slugBase = slugify(slugSourceText) || placeholderSlug;
  const finalSlug = await uniquifySlug(slugBase, row.id);

  await db.transaction(async (tx) => {
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
    if (capRows.length > 0) await tx.insert(captions).values(capRows);

    if (enrichment.descriptions.length > 0) {
      await tx.insert(descriptions).values(
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
      await tx
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

    if (finalSlug !== placeholderSlug) {
      await tx.update(images).set({ slug: finalSlug }).where(eq(images.id, row.id));
    }
  });

  const full = await getImageBySlug(finalSlug);
  return NextResponse.json({ image: full }, { status: 201 });
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 64);
}
