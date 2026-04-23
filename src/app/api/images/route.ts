import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { put } from '@vercel/blob';
import { auth, isOwner } from '@/lib/auth';
import { getEmbedder } from '@/lib/ai';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { db } from '@/lib/db/client';
import { captions, descriptions, images, tags } from '@/lib/db/schema';
import { enrichImage } from '@/lib/enrichment';
import { extractExif, extractPalette } from '@/lib/image-meta';
import { slugify } from '@/lib/slug';
import { uniquifySlug } from '@/lib/db/queries/slugs';
import { getImageBySlug, listImages } from '@/lib/db/queries/images';
import { upsertEmbedding } from '@/lib/db/queries/embeddings';
import { emit } from '@/lib/webhooks/emit';

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

  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    console.error('failed to parse multipart form', err);
    return NextResponse.json({ error: 'invalid multipart body' }, { status: 400 });
  }

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
  // A missing/invalid BLOB_READ_WRITE_TOKEN raises here; surface it as JSON so the
  // client doesn't choke trying to parse Next's HTML error page.
  const blobKey = `images/${crypto.randomUUID()}-${safeName(file.name)}`;
  let blob: Awaited<ReturnType<typeof put>>;
  try {
    blob = await put(blobKey, buffer, {
      access: 'public',
      contentType: mime,
      addRandomSuffix: false
    });
  } catch (err) {
    console.error('blob upload failed', err);
    return NextResponse.json({ error: 'blob upload failed' }, { status: 502 });
  }

  // Extract EXIF + palette from the buffer before the row insert so they
  // land on the first write. Both helpers swallow their own errors; at worst
  // we persist nulls and can backfill later.
  const [{ exif, takenAt }, palette] = await Promise.all([
    extractExif(buffer),
    extractPalette(buffer)
  ]);

  // Reserve the row with a placeholder slug. We'll replace it with the real
  // caption-derived slug after enrichment succeeds.
  const placeholderSlug = `img-${blob.pathname.split('/').pop()!.slice(0, 32)}`;
  let row: typeof images.$inferSelect | undefined;
  try {
    [row] = await db
      .insert(images)
      .values({
        slug: placeholderSlug,
        blobUrl: blob.url,
        blobKey: blob.pathname,
        mime,
        ownerId: session!.user!.githubId!,
        manualCaption: manualCaption ?? null,
        exif: exif ?? null,
        palette: palette.length > 0 ? palette : null,
        takenAt: takenAt ?? null
      })
      .returning();
  } catch (err) {
    console.error('failed to insert image row', err);
    return NextResponse.json({ error: 'failed to create image row' }, { status: 500 });
  }

  if (!row) {
    return NextResponse.json({ error: 'failed to create image row' }, { status: 500 });
  }

  // Run the synchronous enrichment. On failure we leave the image row with its
  // placeholder slug so the owner can retry/edit -- better than losing the upload.
  const cfg = await loadAiConfig();
  let enrichment;
  try {
    enrichment = await enrichImage(buffer, mime, cfg, manualCaption);
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

  // Generate + store the caption embedding. Runs after the enrichment
  // transaction so a failure here doesn't roll back the upload -- semantic
  // search will just miss this image until a Phase 4 reprocess fills it in.
  try {
    const embedText = slugSourceText;
    const embedder = getEmbedder(cfg);
    const vec = await embedder.embed(embedText);
    await upsertEmbedding({
      imageId: row.id,
      kind: 'caption',
      vec,
      provider: embedder.name,
      model: embedder.model
    });
  } catch (err) {
    console.error('embedding generation failed for image', row.id, err);
  }

  const full = await getImageBySlug(finalSlug);

  // Fire webhook subscribers after every DB commit so payloads reference
  // persisted rows. The emitter only enqueues delivery jobs; a slow consumer
  // can't block this response.
  if (full) {
    await emit('image.created', {
      image: {
        id: full.id,
        slug: full.slug,
        blobUrl: full.blobUrl,
        width: full.width,
        height: full.height,
        takenAt: full.takenAt ? full.takenAt.toISOString() : null,
        uploadedAt: full.uploadedAt.toISOString()
      },
      captions: full.captions.map((c) => ({
        variant: c.variant,
        text: c.text,
        isSlugSource: c.isSlugSource
      })),
      tags: full.tags.map((t) => ({
        tag: t.tag,
        source: t.source as 'taxonomy' | 'freeform',
        confidence: t.confidence
      }))
    });
  }

  return NextResponse.json({ image: full }, { status: 201 });
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 64);
}
