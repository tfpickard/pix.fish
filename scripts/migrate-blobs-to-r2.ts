/**
 * One-off, non-destructive copy of every blob object from Vercel Blob into
 * Cloudflare R2, under the identical key. Writes NOTHING to the database --
 * a separate script rewrites the stored URLs once this reports zero failures.
 *
 *   bun scripts/migrate-blobs-to-r2.ts             # dry run (default)
 *   bun scripts/migrate-blobs-to-r2.ts --apply     # actually copy
 *
 * Runs days before the production cutover while the live site still serves
 * from Vercel Blob, so it must be safe to run repeatedly (resumable) and safe
 * to interrupt (each object is copied independently; a killed run just leaves
 * the remaining objects to a re-run).
 *
 * What gets copied, all keys derived from the DB, nothing guessed:
 *   - originals:    images.blobKey  <- images.blobUrl
 *   - derivatives:  derivativeKey(images.blobKey, w) <- entry.url, for each
 *                   entry in images.derivatives (nullable JSONB array)
 *   - character crops: characterCrops.blobKey <- characterCrops.blobUrl
 * Backups are skipped -- they are regenerable and large, not worth the transfer.
 *
 * Requires POSTGRES_URL, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 * R2_BUCKET in the environment.
 */
import { HeadObjectCommand, NotFound, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { db } from '../src/lib/db/client';
import { characterCrops, images } from '../src/lib/db/schema';
import { derivativeKey } from '../src/lib/images/generate';

const apply = process.argv.includes('--apply');

// Bounded worker pool: enough parallelism to keep a slow-ish network busy
// without opening so many concurrent streams that the eventual 4GB-RAM host
// starts thrashing on buffered HTTP/TLS state.
const CONCURRENCY = 12;

const REQUIRED_ENV = ['POSTGRES_URL', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const;

type CopyTask = {
  key: string;
  sourceUrl: string;
  // Human-readable origin for progress lines and the failure report -- not
  // used for anything functional.
  label: string;
};

type Result =
  | { key: string; label: string; outcome: 'copied' }
  | { key: string; label: string; outcome: 'skipped' }
  | { key: string; label: string; outcome: 'failed'; error: string };

function assertEnv(): void {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(`missing required env var(s): ${missing.join(', ')}`);
    process.exit(1);
  }
}

// Collect every (key, sourceUrl) pair to copy. Pure DB read -- no network,
// no R2 calls -- so this can run standalone to sanity-check the count.
async function collectTasks(): Promise<CopyTask[]> {
  const tasks: CopyTask[] = [];

  const imageRows = await db
    .select({
      id: images.id,
      blobKey: images.blobKey,
      blobUrl: images.blobUrl,
      derivatives: images.derivatives
    })
    .from(images);

  for (const row of imageRows) {
    tasks.push({ key: row.blobKey, sourceUrl: row.blobUrl, label: `image ${row.id} original` });
    if (row.derivatives) {
      for (const d of row.derivatives) {
        tasks.push({
          key: derivativeKey(row.blobKey, d.w),
          sourceUrl: d.url,
          label: `image ${row.id} derivative w${d.w}`
        });
      }
    }
  }

  const cropRows = await db
    .select({
      id: characterCrops.id,
      blobKey: characterCrops.blobKey,
      blobUrl: characterCrops.blobUrl
    })
    .from(characterCrops);

  for (const row of cropRows) {
    tasks.push({ key: row.blobKey, sourceUrl: row.blobUrl, label: `crop ${row.id}` });
  }

  return tasks;
}

// True when an object already exists in R2 with the same content length as
// the source is expected to have. Used to make a re-run cheap: a HeadObject
// is far cheaper than re-streaming a whole original.
async function alreadyPresent(
  s3: S3Client,
  bucket: string,
  key: string,
  expectedLength: number | null
): Promise<boolean> {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    if (expectedLength === null) {
      // Source didn't report a length (missing/invalid Content-Length header)
      // -- fall back to "object exists at all" rather than blocking resume.
      return true;
    }
    return head.ContentLength === expectedLength;
  } catch (err) {
    if (err instanceof NotFound) return false;
    // Some S3-compatible backends throw a generic error with $metadata.httpStatusCode
    // instead of the typed NotFound. Treat 404 the same way; anything else is a
    // real problem and should surface as a failure on the subsequent copy attempt
    // rather than being silently swallowed here.
    const status = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (status === 404) return false;
    throw err;
  }
}

// Metadata about a source object, obtained WITHOUT transferring its body.
type SourceInfo = { status: number; length: number | null; contentType: string | undefined };

// Probe the source with HEAD rather than GET. This matters more than it looks:
// the entire reason for this migration is that Vercel bills egress, so a script
// that GETs every object just to decide whether it needs copying would bill the
// very thing we are trying to stop paying. A resumed run touches thousands of
// already-copied objects, and a dry run touches all of them.
//
// Some stores do not answer HEAD. Falling back to a single-byte ranged GET
// keeps the probe nearly free rather than degrading to a full transfer.
async function probeSource(sourceUrl: string): Promise<SourceInfo> {
  const head = await fetch(sourceUrl, { method: 'HEAD' });
  if (head.status !== 405 && head.status !== 501) {
    const len = head.headers.get('content-length');
    return {
      status: head.status,
      length: len ? Number(len) : null,
      contentType: head.headers.get('content-type') ?? undefined
    };
  }

  const ranged = await fetch(sourceUrl, { headers: { Range: 'bytes=0-0' } });
  await ranged.body?.cancel();
  // "bytes 0-0/12345": the total after the slash is the real object size.
  const total = ranged.headers.get('content-range')?.split('/')[1];
  return {
    status: ranged.status === 206 ? 200 : ranged.status,
    length: total && total !== '*' ? Number(total) : null,
    contentType: ranged.headers.get('content-type') ?? undefined
  };
}

async function copyOne(s3: S3Client, bucket: string, task: CopyTask): Promise<Result> {
  const { key, sourceUrl, label } = task;

  let info: SourceInfo;
  try {
    info = await probeSource(sourceUrl);
  } catch (err) {
    return { key, label, outcome: 'failed', error: `source probe threw: ${(err as Error).message}` };
  }

  if (info.status === 404) {
    return { key, label, outcome: 'failed', error: 'source 404 (object no longer exists in Vercel Blob)' };
  }
  if (info.status < 200 || info.status >= 300) {
    return { key, label, outcome: 'failed', error: `source probe failed: HTTP ${info.status}` };
  }

  try {
    if (await alreadyPresent(s3, bucket, key, info.length)) {
      return { key, label, outcome: 'skipped' };
    }
  } catch (err) {
    return { key, label, outcome: 'failed', error: `HeadObject check failed: ${(err as Error).message}` };
  }

  if (!apply) {
    // Dry run stops here, having spent one HEAD against the source and one
    // HeadObject against R2. No body has been requested, so a dry run over the
    // whole corpus costs no egress.
    return { key, label, outcome: 'copied' };
  }

  // Only now, with the object confirmed present at the source and absent from
  // R2, do we ask for the bytes.
  let res: Response;
  try {
    res = await fetch(sourceUrl);
  } catch (err) {
    return { key, label, outcome: 'failed', error: `fetch threw: ${(err as Error).message}` };
  }
  if (!res.ok || !res.body) {
    return { key, label, outcome: 'failed', error: `source fetch failed: ${res.status} ${res.statusText}` };
  }

  const contentType = res.headers.get('content-type') ?? info.contentType;

  try {
    const upload = new Upload({
      client: s3,
      params: {
        Bucket: bucket,
        Key: key,
        // web ReadableStream -- lib-storage streams it in parts rather than
        // buffering the whole object in memory.
        Body: res.body,
        ContentType: contentType,
        CacheControl: 'public, max-age=31536000, immutable'
      },
      queueSize: 4,
      leavePartsOnError: false
    });
    await upload.done();
    return { key, label, outcome: 'copied' };
  } catch (err) {
    return { key, label, outcome: 'failed', error: `upload failed: ${(err as Error).message}` };
  }
}

// Simple bounded worker pool -- no dependency, just N workers pulling off a
// shared index. Order of completion doesn't matter; only the final tally does.
async function runPool(tasks: CopyTask[], s3: S3Client, bucket: string): Promise<Result[]> {
  const results: Result[] = new Array(tasks.length);
  let next = 0;
  let done = 0;
  const total = tasks.length;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await copyOne(s3, bucket, tasks[i]!);
      done++;
      if (done % 25 === 0 || done === total) {
        const copied = results.filter((r) => r?.outcome === 'copied').length;
        const skipped = results.filter((r) => r?.outcome === 'skipped').length;
        const failed = results.filter((r) => r?.outcome === 'failed').length;
        console.log(`  progress: ${done}/${total} (copied=${copied} skipped=${skipped} failed=${failed})`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function main(): Promise<void> {
  assertEnv();

  const accountId = process.env.R2_ACCOUNT_ID!;
  const bucket = process.env.R2_BUCKET!;
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!
    }
  });

  console.log(apply ? 'mode: APPLY (will write to R2)' : 'mode: DRY RUN (pass --apply to write)');

  const tasks = await collectTasks();
  console.log(`found ${tasks.length} object(s) to consider (images + derivatives + character crops)`);
  if (tasks.length === 0) {
    console.log('nothing to do.');
    return;
  }

  const results = await runPool(tasks, s3, bucket);

  const copied = results.filter((r) => r.outcome === 'copied');
  const skipped = results.filter((r) => r.outcome === 'skipped');
  const failed = results.filter((r) => r.outcome === 'failed');

  console.log('');
  console.log('-- final report --');
  console.log(`copied: ${copied.length}`);
  console.log(`skipped (already present in R2): ${skipped.length}`);
  console.log(`failed: ${failed.length}`);

  if (failed.length > 0) {
    console.log('');
    console.log('failures:');
    for (const f of failed) {
      console.log(`  [${f.key}] (${f.label}) -- ${f.error}`);
    }
  }

  if (!apply) {
    console.log('');
    console.log('this was a dry run -- nothing was written. re-run with --apply to copy.');
  }

  // The cutover runbook gates on exit code: any failure must fail the run,
  // even in dry-run mode, since a dry-run failure (e.g. a source 404) will
  // fail again under --apply and is worth surfacing immediately.
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit(process.exitCode ?? 0));
