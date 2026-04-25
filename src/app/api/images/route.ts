import { NextResponse } from 'next/server';
import { inArray } from 'drizzle-orm';
import { put } from '@vercel/blob';
import { auth, isOwner } from '@/lib/auth';
import { db } from '@/lib/db/client';
import { images } from '@/lib/db/schema';
import { extractExif, extractPalette } from '@/lib/image-meta';
import { hydrateImages, listImages } from '@/lib/db/queries/images';
import { enqueueJob } from '@/lib/db/queries/jobs';
import { getGalleryDefaults } from '@/lib/db/queries/gallery-config';
import { getSiteAdminId } from '@/lib/db/queries/users';
import { readShowNsfwCookie } from '@/lib/nsfw';
import { isSortMode, type SortMode } from '@/lib/sort/types';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export async function GET(req: Request) {
  const url = new URL(req.url);

  // Scoped id lookup used by the upload UI to poll per-file enrichment
  // progress. Returns rows hydrated with captions/descriptions/tags so the
  // client can detect "enriched" by checking captions.length > 0.
  const idsParam = url.searchParams.get('ids');
  if (idsParam !== null) {
    const ids = idsParam
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 50);
    if (ids.length === 0) return NextResponse.json({ images: [] });
    const rows = await db.select().from(images).where(inArray(images.id, ids));
    const hydrated = await hydrateImages(rows);
    return NextResponse.json({ images: hydrated });
  }

  const limit = parseIntParam(url.searchParams.get('limit'), 24);
  const offset = parseIntParam(url.searchParams.get('offset'), 0);
  const tagsFilter = url.searchParams.getAll('tag').filter(Boolean);

  const rawSort = url.searchParams.get('sort');
  let sort: SortMode | undefined;
  if (rawSort !== null) {
    if (!isSortMode(rawSort)) {
      return NextResponse.json({ error: `invalid sort: ${rawSort}` }, { status: 400 });
    }
    sort = rawSort;
  } else {
    const defaults = await getGalleryDefaults(getSiteAdminId());
    sort = defaults.defaultSort;
  }
  const seed = url.searchParams.get('seed') ?? undefined;
  // The query param overrides the cookie -- lets clients force include
  // (e.g. signed-in admin tooling) without flipping the visitor cookie.
  const queryIncludeNsfw = url.searchParams.get('include_nsfw');
  const includeNsfw =
    queryIncludeNsfw === '1' || queryIncludeNsfw === 'true'
      ? true
      : await readShowNsfwCookie();

  const rows = await listImages({ limit, offset, tags: tagsFilter, sort, seed, includeNsfw });
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
  const rawManualDescription = form.get('manual_description');
  const manualDescription =
    typeof rawManualDescription === 'string' && rawManualDescription.trim()
      ? rawManualDescription.trim()
      : undefined;
  // Comma-separated manual tags from the upload form. Empty fragments are
  // dropped; lowercasing happens in persistEnrichment.
  const rawManualTags = form.get('manual_tags');
  const manualTags =
    typeof rawManualTags === 'string' && rawManualTags.trim()
      ? rawManualTags
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
  // Checkbox: present-and-truthy means owner asserts NSFW. Absent or
  // explicit 'false'/'0' means no override; the AI verdict (or default
  // false for key-less uploads) wins.
  const rawManualNsfw = form.get('manual_nsfw');
  const manualNsfw =
    rawManualNsfw === 'true' || rawManualNsfw === 'on' || rawManualNsfw === '1'
      ? true
      : undefined;

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file is required' }, { status: 400 });
  }
  const mime = file.type;
  if (!ALLOWED_MIME.has(mime)) {
    return NextResponse.json({ error: `unsupported mime: ${mime}` }, { status: 415 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  // Upload to Vercel Blob first -- we want the URL persisted even if the
  // enrichment job later fails. A missing/invalid BLOB_READ_WRITE_TOKEN
  // surfaces here; report it as JSON so the client doesn't choke on Next's
  // HTML error page.
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

  // EXIF + palette land on the first write so the row is self-describing
  // even before enrichment runs. Both helpers swallow their own errors.
  const [{ exif, takenAt }, palette] = await Promise.all([
    extractExif(buffer),
    extractPalette(buffer)
  ]);

  // Reserve the row with a placeholder slug. The enrich.image job updates
  // the slug after captions come back.
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

  // Hand off enrichment to the background queue. The cron at /api/cron/jobs
  // drains up to 10 jobs per minute, so worst-case pickup latency is ~60s.
  // Keeping the POST thin lets the client fire N parallel uploads without
  // running into the 60s function wall -- see src/components/upload-zone.tsx.
  try {
    await enqueueJob({
      type: 'enrich.image',
      payload: {
        imageId: row.id,
        manualDescription,
        manualTags,
        manualNsfw
      },
      maxAttempts: 3
    });
  } catch (err) {
    // The blob + image row are already persisted; a failure to enqueue is
    // recoverable via /admin/reprocess. Surface it so the client can flag it.
    console.error('failed to enqueue enrich.image job', row.id, err);
    return NextResponse.json(
      { error: 'failed to queue enrichment', image: row },
      { status: 202 }
    );
  }

  return NextResponse.json({ image: row, status: 'queued' }, { status: 202 });
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 64);
}
