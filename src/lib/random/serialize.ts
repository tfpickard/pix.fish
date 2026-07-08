import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { users, type Image } from '@/lib/db/schema';
import { hydrateImages } from '@/lib/db/queries/images';
import { listApprovedComments } from '@/lib/db/queries/comments';
import { absoluteUrl } from '@/lib/site';

// Random variant choice. Mirrors the app's "random selection is server-side per
// request" rule (no stability across refreshes) used for captions/descriptions.
export function pickVariant(texts: string[]): string | null {
  if (texts.length === 0) return null;
  return texts[Math.floor(Math.random() * texts.length)] ?? null;
}

// Byte size from a HEAD on the public blob URL (no token needed). Best-effort:
// any failure -> null so a size lookup never fails the request.
export async function getImageSizeBytes(blobUrl: string): Promise<number | null> {
  try {
    const res = await fetch(blobUrl, { method: 'HEAD' });
    if (!res.ok) return null;
    const len = res.headers.get('content-length');
    if (!len) return null;
    const n = Number(len);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

export function mimeToExt(mime: string | null): string {
  return (mime && MIME_EXT[mime]) || 'jpg';
}

// Download filename for /api/random/raw: "<slug>.<ext>".
export function fileNameFor(row: Image): string {
  return `${row.slug}.${mimeToExt(row.mime)}`;
}

// Owner identity (handle powers the canonical URL). Null for rows whose owner
// predates the users-table backfill.
async function loadOwner(
  ownerId: string
): Promise<{ id: string; handle: string; displayName: string | null } | null> {
  const [row] = await db
    .select({ id: users.id, handle: users.handle, displayName: users.displayName })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);
  return row ?? null;
}

// "Everything we store about it": the full image row (matching the existing
// un-allowlisted /api/images serialization) hydrated with captions/descriptions/
// tags + reaction counts + comment count, plus full approved comments, owner
// identity, canonical URL, and derived byte size.
export async function buildFullRecord(row: Image): Promise<Record<string, unknown>> {
  const [[hydrated], comments, owner, sizeBytes] = await Promise.all([
    hydrateImages([row]),
    listApprovedComments(row.id),
    loadOwner(row.ownerId),
    getImageSizeBytes(row.blobUrl)
  ]);

  const counts = hydrated?.reactionCounts ?? { up: 0, down: 0 };
  const url = owner
    ? absoluteUrl(`/u/${owner.handle}/${row.slug}`)
    : absoluteUrl(`/${row.slug}`);

  return {
    ...hydrated,
    sizeBytes,
    likes: counts.up,
    dislikes: counts.down,
    owner,
    url,
    comments
  };
}

// Streams the original image bytes. Returns the raw fetch Response so the route
// can pipe `.body` through without buffering. Null on upstream failure.
export async function fetchImageStream(blobUrl: string): Promise<Response | null> {
  try {
    const res = await fetch(blobUrl);
    if (!res.ok || !res.body) return null;
    return res;
  } catch {
    return null;
  }
}

// Cap on the ORIGINAL byte size we will base64-encode for /api/random/uri. The
// data: URI inflates ~1.37x and is wrapped in JSON, and the nodejs serverless
// response limit is ~4.5 MB, so we bail well before that. Since /uri is public
// and unauthenticated, the cap also bounds the allocation/CPU a caller can
// force. Larger originals should be fetched via /image or /raw (streamed,
// uncapped) instead of inlined.
export const MAX_DATA_URI_BYTES = 3 * 1024 * 1024;

// Strips any header parameters (e.g. "; charset=...") so the value is a bare
// "type/subtype" suitable for a data: URI -- and never a header-injection vector.
function normalizeMime(raw: string | null | undefined): string {
  const base = (raw ?? '').split(';')[0]?.trim().toLowerCase();
  return base || 'application/octet-stream';
}

export type DataUriResult =
  | { ok: true; dataUri: string; mime: string; sizeBytes: number }
  | { ok: false; reason: 'too_large' | 'unavailable' };

// Reads the image and base64-encodes it as a data: URI for inline embedding.
// Enforces MAX_DATA_URI_BYTES: the Content-Length pre-check bails BEFORE
// allocating (Vercel Blob always sends it), and a post-read guard covers the
// rare no-Content-Length case.
export async function fetchImageDataUri(row: Image): Promise<DataUriResult> {
  try {
    const res = await fetch(row.blobUrl);
    if (!res.ok || !res.body) return { ok: false, reason: 'unavailable' };
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_DATA_URI_BYTES) {
      return { ok: false, reason: 'too_large' };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_DATA_URI_BYTES) {
      return { ok: false, reason: 'too_large' };
    }
    const mime = normalizeMime(row.mime || res.headers.get('content-type'));
    return {
      ok: true,
      dataUri: `data:${mime};base64,${buf.toString('base64')}`,
      mime,
      sizeBytes: buf.byteLength
    };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}
