import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { images, users, type Image } from '@/lib/db/schema';
import { pickRandomImageRow } from '@/lib/db/queries/random';
import { resolveNsfwMode } from '@/lib/http-params';
import type { NsfwMode } from '@/lib/nsfw';

// Resolves the image an /api/random/* request operates on. Default is a fresh
// random pick. To pin a SPECIFIC image (so a client can call /api/random once
// and then fetch individual fields of the same image), pass one of:
//   ?id=<numeric id>       -- globally unique, the reliable way to pin.
//   ?slug=<slug>&handle=<h> -- owner-scoped and unique (slug is unique per owner).
//   ?slug=<slug>           -- best-effort: slugs are unique only per owner, so a
//                             bare slug resolves to the OLDEST match across users
//                             and may not be the image /api/random returned.
// The full record from /api/random exposes both `id` and `owner.handle`, so
// prefer id (or slug+handle) to pin reliably. All paths honor the visitor's NSFW
// preference (?include_nsfw= overrides the cookie) and hide archived + basement.
export async function selectImage(req: Request): Promise<Image | null> {
  const url = new URL(req.url);
  const nsfwMode = await resolveNsfwMode(url.searchParams.get('include_nsfw'));

  const idParam = url.searchParams.get('id');
  const slugParam = url.searchParams.get('slug');
  const handleParam = url.searchParams.get('handle');
  if (idParam !== null || slugParam !== null) {
    return fetchPinned({ idParam, slugParam, handleParam, nsfwMode });
  }
  return pickRandomImageRow({ nsfwMode });
}

async function fetchPinned(params: {
  idParam: string | null;
  slugParam: string | null;
  handleParam: string | null;
  nsfwMode: NsfwMode;
}): Promise<Image | null> {
  const { idParam, slugParam, handleParam, nsfwMode } = params;
  let row: Image | undefined;
  if (idParam !== null) {
    // Globally-unique primary key: the reliable pin.
    const id = Number(idParam);
    if (!Number.isInteger(id) || id <= 0) return null;
    [row] = await db.select().from(images).where(eq(images.id, id)).limit(1);
  } else if (slugParam !== null && handleParam !== null) {
    // (handle, slug) is unique -- handle is unique and slug is unique per owner,
    // so this resolves to exactly the owner's image. Handles are stored/compared
    // lowercase (mirrors /api/u/[handle]/images).
    const [hit] = await db
      .select({ image: images })
      .from(images)
      .innerJoin(users, eq(users.id, images.ownerId))
      .where(and(eq(users.handle, handleParam.toLowerCase()), eq(images.slug, slugParam)))
      .limit(1);
    row = hit?.image;
  } else if (slugParam !== null) {
    // Bare slug: best-effort. Slugs are unique per owner, so a slug may match
    // several users; pick the oldest deterministically (matches the legacy
    // /<slug> tiebreak). Use ?id= or ?slug=&handle= to pin unambiguously.
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
