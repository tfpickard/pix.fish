/**
 * Offline image-derivative generator.
 *
 * For every image, resizes the original to a small set of WebP widths and
 * uploads them to the same Vercel Blob store as the original, then records the
 * resulting URLs on images.derivatives. The web app reads that column so
 * gallery tiles serve a small derivative instead of the full-res original (and
 * the optimizer never re-transforms originals at request time).
 *
 * Additive and non-destructive: originals are never deleted or overwritten;
 * derivatives are written to distinct keys (`<original-base>.w<width>.webp`).
 *
 * Idempotent: rows that already have a `derivatives` value are skipped unless
 * --force is passed (which re-downloads, re-encodes, and overwrites in place --
 * derivative keys are stable, so put() with addRandomSuffix:false replaces).
 *
 *   bun scripts/generate-derivatives.ts            # process rows missing derivatives
 *   bun scripts/generate-derivatives.ts --force    # regenerate all rows
 *   bun scripts/generate-derivatives.ts --limit 5  # process at most 5 (trial run)
 *
 * Requires POSTGRES_URL and BLOB_READ_WRITE_TOKEN in the environment.
 */
import { del, put } from '@vercel/blob';
import { asc, eq, isNull } from 'drizzle-orm';
import sharp from 'sharp';
import { db } from '../src/lib/db/client';
import { images } from '../src/lib/db/schema';
import {
  DERIVATIVE_WIDTHS,
  type ImageDerivative,
  type ImageDerivatives
} from '../src/lib/images/derivatives';

const WEBP_QUALITY = 80;
const MAX_WIDTH = DERIVATIVE_WIDTHS[DERIVATIVE_WIDTHS.length - 1];

const force = process.argv.includes('--force');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity;

// The set of widths to render for a given original width. Downscale-only:
// never request a width larger than the original (sharp's withoutEnlargement
// would clamp it anyway, but this keeps us from writing duplicate-resolution
// files). Always include a top entry at min(originalWidth, MAX_WIDTH) so even a
// small original yields one compressed WebP and the detail view has a "largest"
// to show. When the original width is unknown, fall back to the full ladder and
// let withoutEnlargement clamp.
function targetWidths(originalWidth: number | undefined): number[] {
  if (originalWidth === undefined) return [...DERIVATIVE_WIDTHS];
  const set = new Set<number>(DERIVATIVE_WIDTHS.filter((w) => w < originalWidth));
  set.add(Math.min(originalWidth, MAX_WIDTH));
  return [...set].sort((a, b) => a - b);
}

// `<base>.w<width>.webp` from the original blob key, dropping the original
// extension. Stable per (image, width) so reruns overwrite rather than fork.
function derivativeKey(blobKey: string, width: number): string {
  const base = blobKey.replace(/\.[a-zA-Z0-9]+$/, '');
  return `${base}.w${width}.webp`;
}

async function processRow(row: {
  id: number;
  slug: string;
  blobUrl: string;
  blobKey: string;
}): Promise<number> {
  const res = await fetch(row.blobUrl);
  if (!res.ok) throw new Error(`fetch original ${res.status}`);
  const original = Buffer.from(await res.arrayBuffer());

  const meta = await sharp(original).metadata();

  // Animated originals (GIF / animated WebP): a plain sharp() pipeline decodes
  // only the first frame, so a derivative would be a still. Since the gallery
  // now prefers derivatives over the original, that would silently freeze
  // animated images. Skip them -- record an empty set so the row is marked
  // processed (not retried every run) and every consumer falls back to the
  // original, which keeps animating. (Generating animated WebP derivatives is a
  // possible future enhancement; it needs sharp({ animated: true }) and care
  // around per-frame resizing cost.)
  if ((meta.pages ?? 1) > 1) {
    await db.update(images).set({ derivatives: [] }).where(eq(images.id, row.id));
    return 0;
  }

  const widths = targetWidths(meta.width);

  // Dedupe by the ACTUAL output width (withoutEnlargement can collapse two
  // requested widths onto the same real width when the original is small).
  const byWidth = new Map<number, ImageDerivative>();
  for (const width of widths) {
    const { data, info } = await sharp(original)
      // Honor EXIF orientation so derivatives are never sideways.
      .rotate()
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });
    const key = derivativeKey(row.blobKey, info.width);
    const blob = await put(key, data, {
      access: 'public',
      contentType: 'image/webp',
      addRandomSuffix: false
      // Stable keys: --force and partial-failure repairs re-put the same path.
      // @vercel/blob 0.27.x overwrites an existing key by default (it has no
      // allowOverwrite option). If this dep is ever upgraded to v1+, which
      // rejects overwrites by default, add `allowOverwrite: true` here.
    });
    byWidth.set(info.width, { w: info.width, url: blob.url });
  }

  const derivatives: ImageDerivatives = [...byWidth.values()].sort((a, b) => a.w - b.w);
  await db.update(images).set({ derivatives }).where(eq(images.id, row.id));
  return derivatives.length;
}

// Blob-store host id from a public blob URL ("https://<id>.public.blob...").
function storeIdFromUrl(url: string): string | null {
  try {
    return new URL(url).host.split('.')[0] ?? null;
  } catch {
    return null;
  }
}

// Fail fast on a misconfigured blob token. The common footgun is a
// BLOB_READ_WRITE_TOKEN for a different store than the one hosting the
// originals: every original reads fine (public URLs need no token) but every
// put() fails with "This store does not exist", once per image. One test
// write up front turns that into a single clear error. `sampleOriginalUrl`
// lets the message name the store the originals actually live in.
async function preflightBlobWrite(sampleOriginalUrl: string): Promise<void> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error('BLOB_READ_WRITE_TOKEN is not set');
  }
  const probeKey = 'images/.derivatives-preflight';
  try {
    const blob = await put(probeKey, 'ok', {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'text/plain'
      // Fixed probe key; @vercel/blob 0.27.x overwrites by default, so a prior
      // run's probe object doesn't conflict (see the note in processRow).
    });
    await del(blob.url).catch(() => {
      // Best effort: the probe object is tiny; a failed cleanup isn't fatal.
    });
  } catch (err) {
    const originStore = storeIdFromUrl(sampleOriginalUrl);
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `blob write preflight failed: ${detail}. ` +
        `BLOB_READ_WRITE_TOKEN must be for the store hosting the originals` +
        (originStore ? ` (store id "${originStore}")` : '') +
        '. Pull it from the linked Vercel project (vercel env pull) or the' +
        ' Blob store\'s tokens page.'
    );
  }
}

async function main() {
  // Filter in SQL so reruns and partial backfills don't pull (and hold in
  // memory) every row only to skip most in JS. Without --force we only fetch
  // rows that still need derivatives; with --force we reprocess everything.
  const rows = await db
    .select({
      id: images.id,
      slug: images.slug,
      blobUrl: images.blobUrl,
      blobKey: images.blobKey
    })
    .from(images)
    .where(force ? undefined : isNull(images.derivatives))
    .orderBy(asc(images.id));

  if (rows.length === 0) {
    console.log('no images need derivatives');
    return;
  }

  // Validate the blob token before churning through sharp on every row.
  await preflightBlobWrite(rows[0].blobUrl);

  let processed = 0;
  let failed = 0;
  let written = 0;

  for (const row of rows) {
    if (processed >= limit) break;
    try {
      const n = await processRow(row);
      processed++;
      written += n;
      console.log(`  [${row.id}] ${row.slug} -- ${n} derivative(s)`);
    } catch (err) {
      failed++;
      console.error(`  [${row.id}] ${row.slug} -- failed:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`done: ${processed} processed (${written} files), ${failed} failed`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit(0));
