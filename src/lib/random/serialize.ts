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

// Reads the image fully and base64-encodes it as a data: URI for inline embed.
// Null on upstream failure.
export async function fetchImageDataUri(
  row: Image
): Promise<{ dataUri: string; mime: string; sizeBytes: number } | null> {
  try {
    const res = await fetch(row.blobUrl);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = row.mime || res.headers.get('content-type') || 'application/octet-stream';
    return {
      dataUri: `data:${mime};base64,${buf.toString('base64')}`,
      mime,
      sizeBytes: buf.byteLength
    };
  } catch {
    return null;
  }
}
