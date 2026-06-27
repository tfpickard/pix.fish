import { NextResponse } from 'next/server';
import { inArray, asc } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { images, captions, users } from '@/lib/db/schema';
import { getEdgesForNodes, getEdgesForNodesExcludingNsfw, getEdgesForNodesNsfwOnly } from '@/lib/db/queries/knn';
import { getCaptionVector } from '@/lib/db/queries/embeddings';
import { findPath } from '@/lib/knn';
import { resolveNsfwMode } from '@/lib/http-params';
import type { PathNode, PathResponse } from '@/lib/knn-path-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Re-export the shared types so callers that import from this route for
// convenience (e.g. tests) still get them without reaching into src/lib.
export type { PathNode, PathResponse };

// Public endpoint: find the shortest path between two images through the
// kNN graph. Does NOT require authentication because the path data only
// reveals image ids/slugs/blobUrls already visible on the public gallery.
//
// GET /api/path?a=<imageId>&b=<imageId>
//
// Response shapes:
//   200 { found: true,  path: PathNode[], totalDist: number }
//   200 { found: false, reason: 'same-node' | 'no-path' | 'missing-embedding' }
//   400 { error: '...' }   -- invalid params
//
// The disconnected / same-node cases return 200 (not 4xx/5xx) because they
// are valid query outcomes, not caller errors. The UI uses `found` to branch.

export async function GET(req: Request): Promise<NextResponse<PathResponse | { error: string }>> {
  const { searchParams } = new URL(req.url);
  const rawA = searchParams.get('a');
  const rawB = searchParams.get('b');

  const a = rawA ? parseInt(rawA, 10) : NaN;
  const b = rawB ? parseInt(rawB, 10) : NaN;

  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0) {
    return NextResponse.json({ error: 'params a and b must be positive integer image ids' }, { status: 400 });
  }

  if (a === b) {
    return NextResponse.json({ found: false, reason: 'same-node' });
  }

  // Verify both images exist before running Dijkstra, so we return a clean
  // 400 rather than a confusing no-path when the caller passes a bad id. Pull
  // isNsfw too so we can gate the endpoints against the visitor's NSFW mode.
  const existCheck = await db
    .select({ id: images.id, isNsfw: images.isNsfw })
    .from(images)
    .where(inArray(images.id, [a, b]));
  const existById = new Map(existCheck.map((r) => [r.id, r]));
  if (!existById.has(a) || !existById.has(b)) {
    return NextResponse.json({ error: 'one or both image ids not found' }, { status: 400 });
  }

  // Gate BOTH endpoints by the visitor's NSFW mode. The edge loader only
  // filters edge *destinations*, so a hidden image passed as the start node (a)
  // would otherwise be expanded as Dijkstra's seed and ship its blobUrl to a
  // hide-mode visitor. The a/b ids are enumerable, so that is a real
  // content-gating bypass. Requiring both endpoints to be visible under the
  // mode closes it (and is correct for 'only' mode, where SFW endpoints hide).
  const nsfwMode = await resolveNsfwMode(searchParams.get('include_nsfw'));
  const visibleUnderMode = (isNsfw: boolean) =>
    nsfwMode === 'include' ? true : nsfwMode === 'only' ? isNsfw : !isNsfw;
  if (!visibleUnderMode(existById.get(a)!.isNsfw) || !visibleUnderMode(existById.get(b)!.isNsfw)) {
    return NextResponse.json({ found: false, reason: 'no-path' });
  }

  // Check both endpoints have a caption embedding before running Dijkstra.
  // Without an embedding the image was never added to the kNN graph, so the
  // true reason for no path is a missing embedding, not graph disconnection.
  // Checking here lets us surface the precise error instead of a generic no-path.
  const [vecA, vecB] = await Promise.all([getCaptionVector(a), getCaptionVector(b)]);
  if (!vecA || !vecB) {
    return NextResponse.json({ found: false, reason: 'missing-embedding' });
  }

  // The filtered edge loader keeps intermediate nodes in-scope; combined with
  // the endpoint gate above, no hidden image can appear in the path.
  const edgeLoader =
    nsfwMode === 'only' ? getEdgesForNodesNsfwOnly :
    nsfwMode === 'include' ? getEdgesForNodes :
    getEdgesForNodesExcludingNsfw;

  // Run Dijkstra with lazy edge loading from the DB.
  const result = await findPath(a, b, edgeLoader);

  if (!result.found) {
    return NextResponse.json({ found: false, reason: result.reason });
  }

  // Hydrate path nodes: fetch image rows + canonical captions + owner handles
  // in two round-trips (images+captions parallel, then handles).
  const pathIds = result.path;

  const [imageRows, captionRows] = await Promise.all([
    db
      .select({ id: images.id, slug: images.slug, blobUrl: images.blobUrl, ownerId: images.ownerId, isNsfw: images.isNsfw })
      .from(images)
      .where(inArray(images.id, pathIds)),
    db
      .select({ imageId: captions.imageId, text: captions.text, isSlugSource: captions.isSlugSource, variant: captions.variant })
      .from(captions)
      .where(inArray(captions.imageId, pathIds))
      .orderBy(asc(captions.imageId), asc(captions.variant))
  ]);

  // Defense in depth: if any node on the reconstructed path is not visible
  // under the visitor's NSFW mode, refuse the whole path rather than ship even
  // one hidden blobUrl. The endpoint gate + filtered loader should already
  // guarantee this, so it makes the privacy property independent of the
  // loader's internals instead of merely a comment that asserts it.
  if (imageRows.some((r) => !visibleUnderMode(r.isNsfw))) {
    return NextResponse.json({ found: false, reason: 'no-path' });
  }

  // Collect unique ownerIds to fetch handles in one query.
  const ownerIds = [...new Set(imageRows.map((r) => r.ownerId))];
  const userRows = await db
    .select({ id: users.id, handle: users.handle })
    .from(users)
    .where(inArray(users.id, ownerIds));

  const handleByOwner = new Map(userRows.map((u) => [u.id, u.handle]));
  const imageById = new Map(imageRows.map((r) => [r.id, r]));

  // Group captions by imageId, pick the best one per image. Preference order:
  // isSlugSource=true (the caption the slug was derived from, usually the
  // most descriptive) > lowest variant number > empty string.
  // captionRows are already sorted by (imageId ASC, variant ASC).
  const captionByImage = new Map<number, string>();
  for (const c of captionRows) {
    if (!captionByImage.has(c.imageId)) {
      captionByImage.set(c.imageId, c.text);
    } else if (c.isSlugSource) {
      captionByImage.set(c.imageId, c.text);
    }
  }

  // Assemble path in the order Dijkstra returned, preserving traversal order.
  const path: PathNode[] = pathIds.map((id) => {
    const img = imageById.get(id);
    if (!img) {
      // Should not happen since we verified both endpoints and the graph only
      // contains ids that had embeddings at build time. Log and use a sentinel.
      console.error(`/api/path: image ${id} in path but not found in DB`);
    }
    return {
      imageId: id,
      slug: img?.slug ?? '',
      blobUrl: img?.blobUrl ?? '',
      handle: handleByOwner.get(img?.ownerId ?? '') ?? '',
      caption: captionByImage.get(id) ?? img?.slug ?? ''
    };
  });

  return NextResponse.json({ found: true, path, totalDist: result.totalDist });
}
