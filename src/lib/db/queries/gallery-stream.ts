import { memoTtl } from '@/lib/cache/ttl-memo';
import type { NsfwMode } from '@/lib/nsfw';
import type { SortMode } from '../../sort/types';
import {
  countImages,
  getOwnerHandlesForImages,
  listImages,
  type ImageWithRelations
} from './images';
import { tagCloud, type TagCount } from './tags';

// How long a gallery read is reused before the next request refreshes it.
// The stream is a browsable wall of pictures, not a ledger -- a visitor
// seeing a window that is up to half a minute old is invisible, while the
// difference in database load between "every request" and "twice a minute"
// is three orders of magnitude at spike volume.
export const GALLERY_STREAM_TTL_MS = 30_000;

// Gallery defaults are a single admin-owned config row that changes when the
// admin edits it and never otherwise, so it tolerates a much longer TTL than
// the image stream.
export const GALLERY_DEFAULTS_TTL_MS = 300_000;

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

function streamKey(q: GalleryQuery, limit: number, offset: number): string {
  return `stream:${q.sort}:${q.nsfwMode}:${limit}:${offset}`;
}

/**
 * Cached gallery page read, shared by the homepage and `/api/images`.
 *
 * Throws if the underlying query throws -- callers that want the fail-soft
 * empty shell should catch. Failed loads are never retained by the memo, so
 * a database blip does not pin an error for the whole TTL.
 */
export function getGalleryPage(
  q: GalleryQuery,
  limit: number,
  offset: number
): Promise<ImageWithRelations[]> {
  const load = () =>
    listImages({ limit, offset, tags: q.tags, sort: q.sort, seed: q.seed, nsfwMode: q.nsfwMode });

  // Deep pagination is rare and self-limiting; leaving it uncached keeps a
  // crawler walking ?offset= from filling the memo with single-use entries.
  if (!isCacheableShape(q) || offset > 500) return load();
  return memoTtl(streamKey(q, limit, offset), GALLERY_STREAM_TTL_MS, load);
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
export function getHomeStream(q: GalleryQuery): Promise<HomeStream> {
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

  if (!isCacheableShape(q)) return load();
  return memoTtl(`home:${q.sort}:${q.nsfwMode}`, GALLERY_STREAM_TTL_MS, load);
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
  return memoTtl(`gallery-defaults:${adminId ?? 'none'}`, GALLERY_DEFAULTS_TTL_MS, load);
}
