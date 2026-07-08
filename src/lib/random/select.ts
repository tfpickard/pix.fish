import { asc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { images, type Image } from '@/lib/db/schema';
import { pickRandomImageRow } from '@/lib/db/queries/random';
import { resolveNsfwMode } from '@/lib/http-params';
import type { NsfwMode } from '@/lib/nsfw';

// Resolves the image an /api/random/* request operates on. Default is a fresh
// random pick; an optional ?id= / ?slug= pins a specific image so a client can
// call /api/random once and then fetch individual fields of the SAME image.
// Both paths honor the visitor's NSFW preference (?include_nsfw= overrides the
// cookie) and hide archived + basement rows.
export async function selectImage(req: Request): Promise<Image | null> {
  const url = new URL(req.url);
  const nsfwMode = await resolveNsfwMode(url.searchParams.get('include_nsfw'));

  const idParam = url.searchParams.get('id');
  const slugParam = url.searchParams.get('slug');
  if (idParam !== null || slugParam !== null) {
    return fetchPinned({ idParam, slugParam, nsfwMode });
  }
  return pickRandomImageRow({ nsfwMode });
}

async function fetchPinned(params: {
  idParam: string | null;
  slugParam: string | null;
  nsfwMode: NsfwMode;
}): Promise<Image | null> {
  const { idParam, slugParam, nsfwMode } = params;
  let row: Image | undefined;
  if (idParam !== null) {
    const id = Number(idParam);
    if (!Number.isInteger(id) || id <= 0) return null;
    [row] = await db.select().from(images).where(eq(images.id, id)).limit(1);
  } else if (slugParam !== null) {
    // Slugs are unique per owner; a bare slug may match several users. Pick the
    // oldest match deterministically -- matches the legacy /<slug> tiebreak.
    [row] = await db
      .select()
      .from(images)
      .where(eq(images.slug, slugParam))
      .orderBy(asc(images.id))
      .limit(1);
  }
  if (!row) return null;
  // Apply the same visibility rules a random pick would, so pinning can't reach
  // a hidden image the public stream would never show.
  if (row.archivedAt || row.basement) return null;
  if (nsfwMode === 'hide' && row.isNsfw) return null;
  if (nsfwMode === 'only' && !row.isNsfw) return null;
  return row;
}
