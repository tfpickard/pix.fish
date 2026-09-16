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
 * Requires POSTGRES_URL and the R2_* credentials in the environment.
 */
import { del, put } from '../src/lib/blob';
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
// CLI flags, a storage preflight, an SQL filter, and progress logging.

const REQUIRED_R2_ENV = [
  'R2_ACCOUNT_ID',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_BUCKET',
  'R2_PUBLIC_BASE'
] as const;

// Fail fast on storage that cannot be written to. Reads prove nothing here:
// originals are served from a public domain that needs no credentials at all,
// so a wrong key, a wrong bucket, or a read-only token all look fine right up
// until the first put(), and then fail once per image for the whole corpus.
// One probe write up front turns that into a single clear error.
async function preflightBlobWrite(): Promise<void> {
  const missing = REQUIRED_R2_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(`missing required env var(s): ${missing.join(', ')}`);
  }
  const probeKey = 'images/.derivatives-preflight';
  try {
    // Fixed probe key: S3 PutObject overwrites, so a previous run's probe
    // object is not a conflict.
    const blob = await put(probeKey, 'ok', {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'text/plain'
    });
    await del(blob.url).catch(() => {
      // Best effort: the probe object is tiny; a failed cleanup isn't fatal.
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `R2 write preflight failed: ${detail}. Check that R2_BUCKET names an ` +
        'existing bucket and that the access key pair has object write ' +
        'permission on it.'
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
  await preflightBlobWrite();

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
