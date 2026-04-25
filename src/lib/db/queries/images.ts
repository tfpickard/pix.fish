import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  captions,
  comments,
  descriptions,
  embeddings,
  images,
  reactions,
  tags,
  users,
  type Image
} from '../schema';
import {
  CANDIDATE_CAP,
  DEFAULT_SORT,
  type SortMode
} from '../../sort/types';
import {
  antiClump,
  clump,
  drift,
  drunkardsWalk,
  seededShuffle,
  tidal,
  type Candidate
} from '../../sort/reorder';
import { hexToHsl, UNKNOWN_HUE } from '../../sort/hsl';

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value as number), min), max);
}

export type ImageWithRelations = Image & {
  captions: { id: number; variant: number; text: string; isSlugSource: boolean; locked: boolean }[];
  descriptions: { id: number; variant: number; text: string; locked: boolean }[];
  tags: { id: number; tag: string; source: string; confidence: number | null }[];
};

export type ListImagesOpts = {
  limit?: number;
  offset?: number;
  tags?: string[];
  sort?: SortMode;
  seed?: string;
  // Default false: NSFW images are hidden from the public stream. The
  // visitor "Show NSFW" toggle (cookie-backed) opts back in.
  includeNsfw?: boolean;
};

export async function listImages(opts: ListImagesOpts): Promise<ImageWithRelations[]> {
  const limit = clampInt(opts.limit, 24, 1, 100);
  const offset = clampInt(opts.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const sort: SortMode = opts.sort ?? DEFAULT_SORT;
  const seed = opts.seed ?? '';
  const tagFilter = opts.tags && opts.tags.length > 0 ? opts.tags : null;
  const includeNsfw = opts.includeNsfw === true;

  const imageRows = await fetchInSortOrder({ sort, seed, limit, offset, tagFilter, includeNsfw });
  return hydrateImages(imageRows);
}

// AND-composable NSFW predicate. When NSFW is hidden (default), use
// `is_nsfw = false`; when visible, return null so callers skip adding it
// to their WHERE clause entirely.
function nsfwPredicate(includeNsfw: boolean) {
  return includeNsfw ? null : eq(images.isNsfw, false);
}

async function fetchInSortOrder(params: {
  sort: SortMode;
  seed: string;
  limit: number;
  offset: number;
  tagFilter: string[] | null;
  includeNsfw: boolean;
}): Promise<Image[]> {
  const { sort, seed, limit, offset, tagFilter, includeNsfw } = params;

  // Base row set for SQL-native sorts. Tag-filter composes by restricting
  // the images set up front.
  switch (sort) {
    case 'newest':
      return selectImagesOrdered(tagFilter, sql`${images.uploadedAt} DESC, ${images.id} DESC`, limit, offset, includeNsfw);
    case 'oldest':
      return selectImagesOrdered(tagFilter, sql`${images.uploadedAt} ASC, ${images.id} ASC`, limit, offset, includeNsfw);
    case 'memory-lane':
      return selectImagesOrdered(
        tagFilter,
        sql`${images.takenAt} ASC NULLS LAST, ${images.uploadedAt} ASC, ${images.id} ASC`,
        limit,
        offset,
        includeNsfw
      );
    case 'chronograph':
      return selectImagesOrdered(
        tagFilter,
        sql`EXTRACT(HOUR FROM COALESCE(${images.takenAt}, ${images.uploadedAt})) ASC,
            ${images.uploadedAt} DESC,
            ${images.id} DESC`,
        limit,
        offset,
        includeNsfw
      );
    case 'lonely':
      return selectLonely(tagFilter, limit, offset, includeNsfw);
    default:
      break;
  }

  // Remaining modes reorder only the top CANDIDATE_CAP rows in memory. For
  // offsets past the window we stitch on the raw base-order tail so
  // /api/images stays paginable across the whole table.
  const newestBase = sql`${images.uploadedAt} DESC, ${images.id} DESC`;
  const oldestBase = sql`${images.uploadedAt} ASC, ${images.id} ASC`;

  if (sort === 'random') {
    const baseRows = await selectImagesOrdered(tagFilter, newestBase, CANDIDATE_CAP, 0, includeNsfw);
    const shuffled = seededShuffle(baseRows, seed || 'unseeded');
    return sliceCandidateWindowWithBaseTail({
      reordered: shuffled,
      tagFilter,
      baseOrder: newestBase,
      limit,
      offset,
      includeNsfw
    });
  }

  if (sort === 'rainbow') {
    const baseRows = await selectImagesOrdered(tagFilter, newestBase, CANDIDATE_CAP, 0, includeNsfw);
    const ordered = baseRows
      .map((row) => ({ row, hue: dominantHue(row.palette) }))
      .sort((a, b) => a.hue - b.hue || a.row.id - b.row.id)
      .map((p) => p.row);
    return sliceCandidateWindowWithBaseTail({
      reordered: ordered,
      tagFilter,
      baseOrder: newestBase,
      limit,
      offset,
      includeNsfw
    });
  }

  if (sort === 'tidal') {
    const baseRows = await selectImagesOrdered(tagFilter, newestBase, CANDIDATE_CAP, 0, includeNsfw);
    const interleaved = tidal(baseRows);
    return sliceCandidateWindowWithBaseTail({
      reordered: interleaved,
      tagFilter,
      baseOrder: newestBase,
      limit,
      offset,
      includeNsfw
    });
  }

  // Embedding-driven reorder modes.
  const direction = sort === 'ancient-drift' ? 'asc' : 'desc';
  const baseOrder = direction === 'asc' ? oldestBase : newestBase;
  const candidates = await fetchCandidates(tagFilter, direction, CANDIDATE_CAP, includeNsfw);
  const reordered = applyReorder(sort, candidates, seed);
  return sliceCandidateWindowWithBaseTail({
    reordered,
    tagFilter,
    baseOrder,
    limit,
    offset,
    includeNsfw
  });
}

// Returns a page out of an in-memory reordered candidate window, stitching
// on older rows from the raw base order when the request straddles or
// exceeds CANDIDATE_CAP. Without this, every reorder sort artificially
// caps at 300 rows.
async function sliceCandidateWindowWithBaseTail(params: {
  reordered: Image[];
  tagFilter: string[] | null;
  baseOrder: ReturnType<typeof sql>;
  limit: number;
  offset: number;
  includeNsfw: boolean;
}): Promise<Image[]> {
  const { reordered, tagFilter, baseOrder, limit, offset, includeNsfw } = params;
  if (limit <= 0) return [];

  // A reordered window shorter than CANDIDATE_CAP means the total table
  // (under the tag filter) has fewer rows than the cap, so there's no tail
  // to fetch -- the window is the full result set.
  const hasTail = reordered.length >= CANDIDATE_CAP;

  if (offset >= reordered.length) {
    if (!hasTail) return [];
    return selectImagesOrdered(tagFilter, baseOrder, limit, offset, includeNsfw);
  }

  const windowEnd = Math.min(offset + limit, reordered.length);
  const windowRows = reordered.slice(offset, windowEnd);

  // Page fits entirely within the reordered window.
  if (windowEnd === offset + limit) return windowRows;

  // Page straddles the cap; append rows from base order beyond the window.
  if (!hasTail) return windowRows;
  const remaining = limit - windowRows.length;
  const tailRows = await selectImagesOrdered(
    tagFilter,
    baseOrder,
    remaining,
    reordered.length,
    includeNsfw
  );
  return windowRows.concat(tailRows);
}

function applyReorder(sort: SortMode, candidates: Candidate[], seed: string): Image[] {
  switch (sort) {
    case 'drifting':
    case 'ancient-drift':
      return drift(candidates);
    case 'clumped':
      return clump(candidates);
    case 'anti-clumped':
      return antiClump(candidates);
    case 'drunkards-walk':
      return drunkardsWalk(candidates, { seed: seed || 'unseeded' });
    default:
      return candidates.map((c) => c.image);
  }
}

async function selectImagesOrdered(
  tagFilter: string[] | null,
  orderBy: ReturnType<typeof sql>,
  limit: number,
  offset: number,
  includeNsfw: boolean
): Promise<Image[]> {
  const nsfw = nsfwPredicate(includeNsfw);
  if (tagFilter) {
    const matchingIdsSubquery = db
      .select({ id: tags.imageId })
      .from(tags)
      .where(inArray(tags.tag, tagFilter))
      .groupBy(tags.imageId)
      .having(sql`count(distinct ${tags.tag}) = ${tagFilter.length}`);
    const where = nsfw
      ? and(inArray(images.id, matchingIdsSubquery), nsfw)
      : inArray(images.id, matchingIdsSubquery);
    return db
      .select()
      .from(images)
      .where(where)
      .orderBy(orderBy)
      .limit(limit)
      .offset(offset);
  }
  const q = db.select().from(images);
  return (nsfw ? q.where(nsfw) : q).orderBy(orderBy).limit(limit).offset(offset);
}

// Lonely: order by (approved-comments + reactions) ascending. LEFT JOIN with
// aggregate subqueries so images with zero engagement come first. Reports
// are deliberately not counted; they're a moderation signal, not engagement.
async function selectLonely(
  tagFilter: string[] | null,
  limit: number,
  offset: number,
  includeNsfw: boolean
): Promise<Image[]> {
  const nsfw = nsfwPredicate(includeNsfw);
  const commentsSub = db
    .select({
      imageId: comments.imageId,
      n: sql<number>`count(*)::int`.as('n')
    })
    .from(comments)
    .where(eq(comments.status, 'approved'))
    .groupBy(comments.imageId)
    .as('c_counts');
  const reactionsSub = db
    .select({
      imageId: reactions.imageId,
      n: sql<number>`count(*)::int`.as('n')
    })
    .from(reactions)
    .groupBy(reactions.imageId)
    .as('r_counts');

  const query = db
    .select({ image: images })
    .from(images)
    .leftJoin(commentsSub, eq(commentsSub.imageId, images.id))
    .leftJoin(reactionsSub, eq(reactionsSub.imageId, images.id));

  const tagWhere = tagFilter
    ? inArray(
        images.id,
        db
          .select({ id: tags.imageId })
          .from(tags)
          .where(inArray(tags.tag, tagFilter))
          .groupBy(tags.imageId)
          .having(sql`count(distinct ${tags.tag}) = ${tagFilter.length}`)
      )
    : null;
  const composed = tagWhere && nsfw ? and(tagWhere, nsfw) : tagWhere ?? nsfw ?? null;
  const ordered = composed ? query.where(composed) : query;

  const rows = await ordered
    .orderBy(
      sql`coalesce(${commentsSub.n}, 0) + coalesce(${reactionsSub.n}, 0) ASC`,
      desc(images.uploadedAt),
      desc(images.id)
    )
    .limit(limit)
    .offset(offset);
  return rows.map((r) => r.image);
}

// Fetches the candidate window for reorder modes: newest-or-oldest N images
// with their caption embedding attached (null if missing).
async function fetchCandidates(
  tagFilter: string[] | null,
  direction: 'asc' | 'desc',
  cap: number,
  includeNsfw: boolean
): Promise<Candidate[]> {
  const nsfw = nsfwPredicate(includeNsfw);
  const orderExpr =
    direction === 'asc'
      ? sql`${images.uploadedAt} ASC, ${images.id} ASC`
      : sql`${images.uploadedAt} DESC, ${images.id} DESC`;

  // We pull the vector as text so we can split it client-side; pgvector's
  // default serialization is "[n1,n2,...]".
  const base = db
    .select({
      image: images,
      vec: sql<string | null>`${embeddings.vec}::text`.as('vec_text')
    })
    .from(images)
    .leftJoin(
      embeddings,
      and(eq(embeddings.imageId, images.id), eq(embeddings.kind, 'caption'))
    );

  const tagWhere = tagFilter
    ? inArray(
        images.id,
        db
          .select({ id: tags.imageId })
          .from(tags)
          .where(inArray(tags.tag, tagFilter))
          .groupBy(tags.imageId)
          .having(sql`count(distinct ${tags.tag}) = ${tagFilter.length}`)
      )
    : null;
  const composed = tagWhere && nsfw ? and(tagWhere, nsfw) : tagWhere ?? nsfw ?? null;
  const scoped = composed ? base.where(composed) : base;

  const rows = await scoped.orderBy(orderExpr).limit(cap);
  return rows.map((r) => ({
    image: r.image,
    embedding: parseVectorLiteral(r.vec)
  }));
}

function parseVectorLiteral(raw: string | null): number[] | null {
  if (!raw) return null;
  const inner = raw.startsWith('[') ? raw.slice(1, -1) : raw;
  if (!inner) return null;
  const arr = inner.split(',').map(Number);
  if (arr.some((n) => !Number.isFinite(n))) return null;
  return arr;
}

function dominantHue(palette: string[] | null): number {
  if (!palette || palette.length === 0) return UNKNOWN_HUE;
  const hsl = hexToHsl(palette[0]!);
  if (!hsl) return UNKNOWN_HUE;
  // Desaturated swatches look grey regardless of hue -- tuck them to the
  // far end so the rainbow actually looks like a rainbow.
  if (hsl.s < 0.1) return UNKNOWN_HUE - 1;
  return hsl.h;
}

// Loads captions/descriptions/tags for a set of pre-fetched image rows and
// merges them into ImageWithRelations. Preserves the input order so callers
// (e.g. semantic search, which orders by vector distance) can control ranking.
export async function hydrateImages(imageRows: Image[]): Promise<ImageWithRelations[]> {
  if (imageRows.length === 0) return [];

  const ids = imageRows.map((i) => i.id);
  const [capRows, descRows, tagRows] = await Promise.all([
    db
      .select()
      .from(captions)
      .where(inArray(captions.imageId, ids))
      .orderBy(asc(captions.imageId), asc(captions.variant)),
    db
      .select()
      .from(descriptions)
      .where(inArray(descriptions.imageId, ids))
      .orderBy(asc(descriptions.imageId), asc(descriptions.variant)),
    db.select().from(tags).where(inArray(tags.imageId, ids)).orderBy(asc(tags.tag))
  ]);

  const capByImage = groupBy(capRows, (r) => r.imageId);
  const descByImage = groupBy(descRows, (r) => r.imageId);
  const tagByImage = groupBy(tagRows, (r) => r.imageId);

  return imageRows.map((img) => ({
    ...img,
    captions: (capByImage.get(img.id) ?? []).map((c) => ({
      id: c.id,
      variant: c.variant,
      text: c.text,
      isSlugSource: c.isSlugSource,
      locked: c.locked
    })),
    descriptions: (descByImage.get(img.id) ?? []).map((d) => ({
      id: d.id,
      variant: d.variant,
      text: d.text,
      locked: d.locked
    })),
    tags: (tagByImage.get(img.id) ?? []).map((t) => ({
      id: t.id,
      tag: t.tag,
      source: t.source,
      confidence: t.confidence
    }))
  }));
}

// Global slug lookup for legacy /<slug> URLs. Slugs are now unique per
// owner, so a slug like `sunset` may exist for multiple users. Tie-break:
// prefer the site admin's row (so original-owner URLs keep resolving),
// otherwise pick the oldest by id (deterministic). Phase F's canonical
// detail page lives at /u/<handle>/<slug> and uses
// `getImageByHandleAndSlug` instead.
export async function getImageBySlug(slug: string): Promise<ImageWithRelations | null> {
  const adminId = process.env.OWNER_GITHUB_ID;
  let img: Image | undefined;
  if (adminId) {
    [img] = await db
      .select()
      .from(images)
      .where(and(eq(images.slug, slug), eq(images.ownerId, adminId)))
      .limit(1);
  }
  if (!img) {
    [img] = await db
      .select()
      .from(images)
      .where(eq(images.slug, slug))
      .orderBy(asc(images.id))
      .limit(1);
  }
  if (!img) return null;
  const [capRows, descRows, tagRows] = await Promise.all([
    db
      .select()
      .from(captions)
      .where(eq(captions.imageId, img.id))
      .orderBy(asc(captions.variant)),
    db
      .select()
      .from(descriptions)
      .where(eq(descriptions.imageId, img.id))
      .orderBy(asc(descriptions.variant)),
    db.select().from(tags).where(eq(tags.imageId, img.id)).orderBy(asc(tags.tag))
  ]);
  return {
    ...img,
    captions: capRows.map((c) => ({
      id: c.id,
      variant: c.variant,
      text: c.text,
      isSlugSource: c.isSlugSource,
      locked: c.locked
    })),
    descriptions: descRows.map((d) => ({
      id: d.id,
      variant: d.variant,
      text: d.text,
      locked: d.locked
    })),
    tags: tagRows.map((t) => ({
      id: t.id,
      tag: t.tag,
      source: t.source,
      confidence: t.confidence
    }))
  };
}

// Canonical owner-scoped lookup powering /u/[handle]/[slug]. Joins users
// to resolve handle -> ownerId in one round-trip. Returns null if the
// handle is unknown or the owner has no image with that slug. Phase D
// callers should prefer this over getImageBySlug; the latter only stays
// for backward-compat redirects.
export async function getImageByHandleAndSlug(
  handle: string,
  slug: string
): Promise<ImageWithRelations | null> {
  const [row] = await db
    .select({ image: images })
    .from(images)
    .innerJoin(users, eq(users.id, images.ownerId))
    .where(and(eq(users.handle, handle), eq(images.slug, slug)))
    .limit(1);
  if (!row) return null;
  return getImageBySlugInner(row.image);
}

async function getImageBySlugInner(img: Image): Promise<ImageWithRelations> {
  const [capRows, descRows, tagRows] = await Promise.all([
    db.select().from(captions).where(eq(captions.imageId, img.id)).orderBy(asc(captions.variant)),
    db
      .select()
      .from(descriptions)
      .where(eq(descriptions.imageId, img.id))
      .orderBy(asc(descriptions.variant)),
    db.select().from(tags).where(eq(tags.imageId, img.id)).orderBy(asc(tags.tag))
  ]);
  return {
    ...img,
    captions: capRows.map((c) => ({
      id: c.id,
      variant: c.variant,
      text: c.text,
      isSlugSource: c.isSlugSource,
      locked: c.locked
    })),
    descriptions: descRows.map((d) => ({
      id: d.id,
      variant: d.variant,
      text: d.text,
      locked: d.locked
    })),
    tags: tagRows.map((t) => ({
      id: t.id,
      tag: t.tag,
      source: t.source,
      confidence: t.confidence
    }))
  };
}

// Resolve owner handles for a list of image ids in one round-trip. Used
// by the home page to feed canonical /u/<handle>/<slug> URLs into the
// CollectionPage JSON-LD without having to hydrate full user rows.
// Returns a Map keyed on image id; rows whose owner pre-dates the
// users-table backfill come back undefined.
export async function getOwnerHandlesForImages(
  imageIds: number[]
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (imageIds.length === 0) return out;
  const rows = await db
    .select({ id: images.id, handle: users.handle })
    .from(images)
    .innerJoin(users, eq(users.id, images.ownerId))
    .where(inArray(images.id, imageIds));
  for (const row of rows) out.set(row.id, row.handle);
  return out;
}

// Per-user gallery for /u/[handle]. Newest-first listing scoped to one
// owner; no embedding-driven sort modes (visitor sees the public stream
// for those). Hydrates captions/descriptions/tags so the grid can render.
// `includeNsfw` honors the visitor's site-wide preference cookie.
export async function listImagesByHandle(
  handle: string,
  opts: { limit?: number; offset?: number; includeNsfw?: boolean } = {}
): Promise<{ owner: { handle: string; displayName: string | null } | null; images: ImageWithRelations[] }> {
  const [user] = await db
    .select({ id: users.id, handle: users.handle, displayName: users.displayName })
    .from(users)
    .where(eq(users.handle, handle))
    .limit(1);
  if (!user) return { owner: null, images: [] };
  const limit = clampInt(opts.limit, 60, 1, 200);
  const offset = clampInt(opts.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const nsfw = nsfwPredicate(opts.includeNsfw === true);
  const where = nsfw ? and(eq(images.ownerId, user.id), nsfw) : eq(images.ownerId, user.id);
  const rows = await db
    .select()
    .from(images)
    .where(where)
    .orderBy(desc(images.uploadedAt), desc(images.id))
    .limit(limit)
    .offset(offset);
  const hydrated = await hydrateImages(rows);
  return {
    owner: { handle: user.handle, displayName: user.displayName },
    images: hydrated
  };
}

// Fetches rows by id preserving the order of the input array. Used by
// semantic search where ranking comes from vector distance, not the DB.
export async function getImagesByIdsOrdered(ids: number[]): Promise<Image[]> {
  if (ids.length === 0) return [];
  const rows = await db.select().from(images).where(inArray(images.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is Image => !!r);
}

// Slim projection for sitemap/feed generation. We don't hydrate captions or
// tags here: a gallery of several thousand rows would otherwise trigger
// captions/descriptions/tags fan-outs that the sitemap has no use for.
// Owner handle is joined in so the sitemap emits canonical
// /u/<handle>/<slug> URLs (Phase D); rows whose owner predates the
// users-table backfill come back with handle=null and the caller falls
// back to legacy /<slug>.
export async function listSitemapImages(): Promise<
  { slug: string; uploadedAt: Date; takenAt: Date | null; ownerHandle: string | null }[]
> {
  const rows = await db
    .select({
      slug: images.slug,
      uploadedAt: images.uploadedAt,
      takenAt: images.takenAt,
      ownerHandle: users.handle
    })
    .from(images)
    .leftJoin(users, eq(users.id, images.ownerId))
    .orderBy(desc(images.uploadedAt));
  return rows;
}

export async function countImages(tagsFilter?: string[]): Promise<number> {
  if (tagsFilter && tagsFilter.length > 0) {
    const matchingIdsSubquery = db
      .select({ id: tags.imageId })
      .from(tags)
      .where(inArray(tags.tag, tagsFilter))
      .groupBy(tags.imageId)
      .having(sql`count(distinct ${tags.tag}) = ${tagsFilter.length}`);
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(images)
      .where(inArray(images.id, matchingIdsSubquery));
    return row?.count ?? 0;
  }
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(images);
  return row?.count ?? 0;
}

function groupBy<T, K>(arr: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const item of arr) {
    const k = key(item);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(item);
  }
  return m;
}
