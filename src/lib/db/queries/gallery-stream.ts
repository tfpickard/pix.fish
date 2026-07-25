import { deleteMemo, memoTtl } from '@/lib/cache/ttl-memo';
import type { NsfwMode } from '@/lib/nsfw';
import type { SortMode } from '../../sort/types';
import {
  countImages,
  getOwnerHandlesForImages,
  listImages,
  selectVisibleImageIds,
  type ImageWithRelations
} from './images';
import { tagCloud, type TagCount } from './tags';

// How long a gallery read is reused before the next request refreshes it.
// The stream is a browsable wall of pictures, not a ledger -- a visitor
// seeing a window that is up to half a minute old is invisible, while the
// difference in database load between "every request" and "twice a minute"
// is three orders of magnitude at spike volume.
export const GALLERY_STREAM_TTL_MS = 30_000;

// Gallery defaults are a single admin-owned config row, so they tolerate a
// longer TTL than the image stream. Not *much* longer, though: the PATCH in
// /api/gallery-config is served by one instance, and a process-local memo on
// any other warm instance cannot be reached from there. 60s bounds how long
// the admin sees a saved setting fail to take effect, while still collapsing
// what is now the most frequent remaining query on the page.
export const GALLERY_DEFAULTS_TTL_MS = 60_000;

// The homepage paints 16 rows into the DOM but feeds 30 to CollectionPage
// JSON-LD (COLLECTION_ITEM_CAP in src/lib/seo/jsonld.ts). Both used to be
// separate listImages() calls with identical arguments; we now fetch the
// wider window once and slice. `drift` and every other reorder mode are
// deterministic over a fixed candidate set, so slice(0, 16) of the 30-row
// result is exactly the old 16-row result -- and the two can no longer
// disagree about which pictures are on the page.
export const HOME_VISIBLE_LIMIT = 16;
export const HOME_SEO_LIMIT = 30;

export type GalleryQuery = {
  tags: string[];
  sort: SortMode;
  seed: string;
  nsfwMode: NsfwMode;
};

export type HomeStream = {
  images: ImageWithRelations[];
  seoImages: ImageWithRelations[];
  totalCount: number;
  cloud: TagCount[];
  handlesByImageId: Map<number, string>;
};

// Only the default-shaped request is memoized. A bare `GET /` -- no tag
// filter, no explicit seed -- is what a crawl or a spike actually hits, and
// restricting the cache to it caps the key space at (sort x nsfwMode) instead
// of letting arbitrary ?seed= / ?tag= values mint unbounded entries. Anything
// exotic falls through to a live query, exactly as before.
function isCacheableShape(q: GalleryQuery): boolean {
  return q.tags.length === 0 && q.seed === '';
}

// listImages() clamps limit/offset internally, but the raw query-string
// values reach the cache key first (parseIntParam does not clamp). Without
// normalizing here, `?offset=-1`, `?offset=-2` and `?limit=99999` each mint
// a distinct key for what resolves to an identical page -- repeating the
// expensive candidate scan and evicting genuinely useful entries. Mirrors
// clampInt() in ./images.
function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 24;
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

function clampOffset(offset: number): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.max(Math.trunc(offset), 0);
}

function streamKey(q: GalleryQuery, limit: number, offset: number): string {
  return `stream:${q.sort}:${q.nsfwMode}:${limit}:${offset}`;
}

// Extra rows fetched beyond the caller's limit so the staleness filter below
// has slack to remove rows without ever returning a short page. This is the
// same trick the homepage already relied on by fetching 30 and painting 16;
// generalizing it is what lets the filter stay honest without any continuation
// arithmetic. See dropStaleRows for why a short page is dangerous.
const STALE_FILTER_SLACK = 8;

// Drops rows that are no longer safe to serve a default-hide visitor -- either
// re-classified NSFW or hard-deleted since the payload was cached. Both happen
// in other processes, so a warm instance can never be told to invalidate; see
// selectVisibleImageIds.
//
// Only 'hide' needs this: 'include' shows everything anyway, and 'only' is
// admin-facing tooling where a 30s-stale row is not a disclosure.
async function dropStaleRows(
  rows: ImageWithRelations[],
  nsfwMode: NsfwMode
): Promise<ImageWithRelations[]> {
  if (nsfwMode !== 'hide' || rows.length === 0) return rows;
  // On error, keep the cached rows. Failing closed would empty the gallery
  // during a blip, and the rows were already filtered on isNsfw at fetch time
  // -- so the cached verdict is the best available answer, not a guess.
  const visible = await selectVisibleImageIds(rows.map((r) => r.id)).catch(() => null);
  if (visible === null) return rows;
  return rows.filter((r) => visible.has(r.id));
}

/**
 * Cached gallery page read, shared by the homepage and `/api/images`.
 *
 * Throws if the underlying query throws -- callers that want the fail-soft
 * empty shell should catch. Failed loads are never retained by the memo, so
 * a database blip does not pin an error for the whole TTL.
 */
export async function getGalleryPage(
  q: GalleryQuery,
  rawLimit: number,
  rawOffset: number
): Promise<ImageWithRelations[]> {
  const limit = clampLimit(rawLimit);
  const offset = clampOffset(rawOffset);

  // Over-fetch so dropStaleRows has slack. Filtering a page down to fewer
  // than `limit` rows is not a cosmetic loss: InfiniteImageGrid latches
  // hasMore=false the moment a response is shorter than pageSize
  // (infinite-image-grid.tsx:153), so one removed row would end the scroll
  // for the session. Slack means the filter almost never shortens the page,
  // and -- unlike topping up from a second query -- it needs no continuation
  // offset. There is no correct continuation offset to compute: the live
  // 'hide' query applies its NSFW predicate before OFFSET, so removing a row
  // shifts every later position by an amount this call cannot know.
  const fetchLimit = clampLimit(limit + STALE_FILTER_SLACK);
  const load = () =>
    listImages({
      limit: fetchLimit,
      offset,
      tags: q.tags,
      sort: q.sort,
      seed: q.seed,
      nsfwMode: q.nsfwMode
    });

  // Deep pagination is rare and self-limiting; leaving it uncached keeps a
  // crawler walking ?offset= from filling the memo with single-use entries.
  const rows =
    !isCacheableShape(q) || offset > 500
      ? await load()
      : await memoTtl(streamKey(q, limit, offset), GALLERY_STREAM_TTL_MS, load);

  // Slice after filtering so the caller gets a full page whenever one exists.
  // Coming up short here now means the query itself ran out of rows, which is
  // genuinely the end of the gallery -- exactly what hasMore=false should
  // mean. A page can still shorten if more than STALE_FILTER_SLACK rows in a
  // single window go away at once, which degrades to ending the scroll early
  // rather than to corrupted offsets.
  const kept = await dropStaleRows(rows, q.nsfwMode);
  return kept.slice(0, limit);
}

/**
 * The homepage payload in one cached unit: the visible window, the wider
 * SEO window, the total count, the tag cloud, and the owner handles needed
 * for canonical JSON-LD URLs.
 *
 * This replaces 18 database round-trips per render -- two of which each
 * pulled 300 rows joined against their 1536-dimension caption embeddings
 * serialized as text -- with one, amortized across the TTL.
 */
export async function getHomeStream(q: GalleryQuery): Promise<HomeStream> {
  const load = async (): Promise<HomeStream> => {
    // The image window is the critical read: if it fails there is no page,
    // so let it reject and drop out of the cache.
    const seoImages = await listImages({
      limit: HOME_SEO_LIMIT,
      tags: q.tags,
      sort: q.sort,
      seed: q.seed,
      nsfwMode: q.nsfwMode
    });
    const images = seoImages.slice(0, HOME_VISIBLE_LIMIT);

    // The trimmings degrade independently: a missing tag cloud or a count
    // that falls back to the visible length is a cosmetic loss, not a broken
    // page, so they must not take the render down with them.
    const [totalCount, cloud, handlesByImageId] = await Promise.all([
      countImages(q.tags, { nsfwMode: q.nsfwMode }).catch(() => images.length),
      tagCloud(64).catch((): TagCount[] => []),
      getOwnerHandlesForImages(seoImages.map((i) => i.id)).catch(
        () => new Map<number, string>()
      )
    ]);

    return { images, seoImages, totalCount, cloud, handlesByImageId };
  };

  const cached = isCacheableShape(q)
    ? await memoTtl(`home:${q.sort}:${q.nsfwMode}`, GALLERY_STREAM_TTL_MS, load)
    : await load();

  // Re-filter after the cache, not inside it, so one payload serves the whole
  // TTL while every response still reflects the current NSFW verdict. The
  // count is left alone: it is a headline figure, not a disclosure.
  const seoImages = await dropStaleRows(cached.seoImages, q.nsfwMode);
  if (seoImages.length === cached.seoImages.length) return cached;
  return {
    ...cached,
    seoImages,
    images: seoImages.slice(0, HOME_VISIBLE_LIMIT)
  };
}

/**
 * Memoized wrapper for the admin gallery-config read. Every homepage render
 * and every un-parameterized `/api/images` call needs it, and it is the same
 * row every time.
 */
export function getCachedGalleryDefaults<T>(
  adminId: string | null,
  load: () => Promise<T>
): Promise<T> {
  return memoTtl(galleryDefaultsKey(adminId), GALLERY_DEFAULTS_TTL_MS, load);
}

function galleryDefaultsKey(adminId: string | null): string {
  return `gallery-defaults:${adminId ?? 'none'}`;
}

/**
 * Drops the memoized gallery defaults after an admin writes them.
 *
 * Only clears the instance that served the write -- the memo is process-local
 * and there is no cross-instance signal -- so this makes the admin's own next
 * page load correct immediately while other warm instances converge within
 * GALLERY_DEFAULTS_TTL_MS. That is the reason the TTL is 60s and not longer.
 */
export function invalidateGalleryDefaults(adminId: string | null): void {
  deleteMemo(galleryDefaultsKey(adminId));
}
