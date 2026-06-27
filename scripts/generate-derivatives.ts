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
import { asc, isNull } from 'drizzle-orm';
import { db } from '../src/lib/db/client';
import { images } from '../src/lib/db/schema';
import { generateImageDerivatives } from '../src/lib/images/generate';

const force = process.argv.includes('--force');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity;

// The per-image work (resize ladder, upload, persist) lives in
// src/lib/images/generate.ts so this backfill and the post-upload derive.image
// job share one implementation. This script adds the offline concerns on top:
// CLI flags, a blob-token preflight, an SQL filter, and progress logging.

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
      // run's probe object doesn't conflict.
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
      const n = await generateImageDerivatives(row);
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
