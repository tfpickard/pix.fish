// Cloudflare R2 storage shim, source-compatible with the subset of
// `@vercel/blob` this codebase uses (`put`/`del`). Backed by the S3-compatible
// R2 API via @aws-sdk/client-s3 + @aws-sdk/lib-storage.
//
// Env vars are read lazily inside put()/del() rather than at module scope so
// importing this file during a build without R2 creds configured doesn't throw.

import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { DeleteObjectsCommand, S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

export type PutResult = { url: string; pathname: string };

type PutOptions = {
  access: 'public';
  contentType?: string;
  addRandomSuffix?: boolean;
};

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

// Memoized: the worker process is long-lived and puts thousands of objects,
// and a fresh S3Client per call rebuilds the credential provider and connection
// pool every time. Unlike the AI providers (which deliberately never cache a
// client, because the API key is per-user), R2 creds are process-wide, so there
// is nothing here that could leak across users.
let cachedClient: S3Client | null = null;

function makeClient(): S3Client {
  if (cachedClient) return cachedClient;
  const accountId = requiredEnv('R2_ACCOUNT_ID');
  cachedClient = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requiredEnv('R2_ACCESS_KEY_ID'),
      secretAccessKey: requiredEnv('R2_SECRET_ACCESS_KEY')
    }
  });
  return cachedClient;
}

// Trailing slashes are stripped because an operator writing
// `R2_PUBLIC_BASE=https://cdn.pix.fish/` is entirely reasonable, and the
// resulting `base//key` is not a cosmetic difference: the empty first path
// segment addresses a DIFFERENT object, so every image 404s. Normalizing here
// means the env var can be written either way.
function publicBase(): string {
  return requiredEnv('R2_PUBLIC_BASE').replace(/\/+$/, '');
}

// Insert a random token before the file extension, mirroring @vercel/blob's
// addRandomSuffix shape ("images/photo.png" -> "images/photo-a1b2c3d4.png").
// Callers persist the returned pathname as a durable DB key (blob_key) and
// derive placeholder slugs from it, so the shape -- not just uniqueness --
// has to match what they expect.
function withRandomSuffix(key: string): string {
  const suffix = randomBytes(4).toString('hex');
  const lastSlash = key.lastIndexOf('/');
  const dir = lastSlash >= 0 ? key.slice(0, lastSlash + 1) : '';
  const base = lastSlash >= 0 ? key.slice(lastSlash + 1) : key;
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx <= 0) return `${dir}${base}-${suffix}`;
  return `${dir}${base.slice(0, dotIdx)}-${suffix}${base.slice(dotIdx)}`;
}

export async function put(
  key: string,
  body: Buffer | Uint8Array | string | Readable,
  opts: PutOptions
): Promise<PutResult> {
  const pathname = opts.addRandomSuffix ? withRandomSuffix(key) : key;

  // `body` can be a live, still-being-written stream: backupExport.ts passes
  // an archiver PassThrough and only awaits its `finalize()` AFTER put()
  // returns, so there's no known length up front and a plain PutObject
  // (which requires ContentLength) can't be used. @aws-sdk/lib-storage's
  // Upload multiparts the body instead of buffering it, which also keeps a
  // multi-gigabyte backup zip out of process memory. Using it for every body
  // type (Buffer/string/small bodies too) is simplest and still correct.
  const uploader = new Upload({
    client: makeClient(),
    params: {
      Bucket: requiredEnv('R2_BUCKET'),
      Key: pathname,
      Body: body,
      ContentType: opts.contentType,
      // Content-addressed objects: this is what lets the Cloudflare CDN
      // absorb crawler traffic instead of re-fetching from R2 every hit.
      CacheControl: 'public, max-age=31536000, immutable'
      // No existence check here: S3-compatible PutObject overwrites an
      // existing key by default, and callers (derivative regeneration, the
      // preflight probe key) rely on that overwrite-by-default behavior.
    }
  });
  await uploader.done();

  return { url: `${publicBase()}/${pathname}`, pathname };
}

// Recover the R2 object key from whatever a caller hands us: a bare key, a
// full R2_PUBLIC_BASE URL, or a legacy https://*.blob.vercel-storage.com/...
// URL left over from before the migration. Callers pass a mix of these in one
// del() call (e.g. image delete: blob_key columns are bare keys, but
// `derivatives[].url` are absolute URLs), so this has to handle all three.
function keyFromTarget(target: string): string {
  const base = publicBase();
  if (target.startsWith(base)) {
    return target.slice(base.length).replace(/^\/+/, '');
  }
  if (/^https?:\/\//.test(target)) {
    try {
      return new URL(target).pathname.replace(/^\/+/, '');
    } catch {
      // Not a parseable URL after all -- fall through and treat it as a key.
    }
  }
  return target;
}

export async function del(target: string | string[]): Promise<void> {
  const targets = Array.isArray(target) ? target : [target];
  if (targets.length === 0) return;

  const keys = targets.map(keyFromTarget);
  const client = makeClient();
  const bucket = requiredEnv('R2_BUCKET');

  // DeleteObjects caps out at 1000 keys per request.
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    const res = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: chunk.map((Key) => ({ Key })) }
      })
    );
    // S3-compatible DeleteObjects treats deleting a nonexistent key as a
    // success (no entry in `Errors`), which is exactly the 404-tolerance
    // callers rely on for best-effort cleanup -- so anything that DOES show
    // up in `Errors` is a real failure (permissions, etc.) and should throw.
    if (res.Errors && res.Errors.length > 0) {
      throw new Error(
        `R2 delete failed for ${res.Errors.length} object(s): ${res.Errors
          .map((e) => `${e.Key}: ${e.Code}`)
          .join(', ')}`
      );
    }
  }
}
