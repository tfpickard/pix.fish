import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../client';
import { images, users, imageLineage } from '../schema';
import { getDecayedAttentionMap } from './attention';
import { getCaptionVector } from './embeddings';

// feat/alive -- query helpers for reproduction, archival, and lineage.
//
// Fitness is decayed attention (see src/lib/attention.ts), so this module
// leans on getDecayedAttentionMap rather than reinventing the decay math.
// Nothing here hard-deletes: archiveImage stamps archivedAt and unarchiveImage
// clears it, so every "death" is reversible. The public query layer already
// hides archivedAt-set rows via buildVisibilityPredicate in images.ts; this
// module is the admin-facing complement that can see and toggle them.

export type FittestImage = {
  imageId: number;
  slug: string;
  handle: string | null;
  blobUrl: string;
  generation: number;
  // Decayed attention score; 0 for images with no attention rows yet.
  fitness: number;
  // Caption embedding if one exists. Null means the image cannot be a
  // reproduction parent (no point to interpolate from).
  embedding: number[] | null;
  archivedAt: Date | null;
};

// Top-N images by decayed attention fitness.
//
// Ranking: active (non-archived) images are scored by decayed attention. Images
// with no attention row score 0; among equally-scored images we fall back to
// uploadedAt DESC so a brand-new, never-viewed image is preferred over an old
// never-viewed one (a sensible "freshness" tiebreak, and it keeps the order
// deterministic). The caption embedding is fetched per row so callers (the
// reproduce route) can interpolate without a second round trip.
//
// Only ACTIVE images are returned: an archived image is "dead" and should not
// be offered as a parent or counted toward fitness ranking. Pass
// includeArchived to override for an admin view that wants the full roster.
export async function getFittestImages(
  n: number,
  opts: { includeArchived?: boolean } = {}
): Promise<FittestImage[]> {
  const limit = Math.min(Math.max(Math.trunc(n), 1), 200);

  // Candidate pool: cap well above `limit` so the decayed re-rank has room to
  // promote a viewed-but-older image above unviewed-but-newer ones. The
  // attention map is sparse (most images have no row), so we re-rank in JS.
  const POOL = Math.max(limit * 5, 60);
  const baseRows = await db
    .select({
      imageId: images.id,
      slug: images.slug,
      handle: users.handle,
      blobUrl: images.blobUrl,
      generation: images.generation,
      uploadedAt: images.uploadedAt,
      archivedAt: images.archivedAt
    })
    .from(images)
    .leftJoin(users, eq(users.id, images.ownerId))
    .where(opts.includeArchived ? undefined : isNull(images.archivedAt))
    .orderBy(desc(images.uploadedAt), desc(images.id))
    .limit(POOL);

  if (baseRows.length === 0) return [];

  const attn = await getDecayedAttentionMap(baseRows.map((r) => r.imageId));

  // Stable sort by (fitness DESC, uploadedAt DESC). baseRows already arrives in
  // uploadedAt DESC, so a stable sort on fitness preserves that as the
  // tiebreak. JS Array.sort is stable in modern engines (and on Vercel's V8).
  const ranked = [...baseRows].sort(
    (a, b) => (attn.get(b.imageId) ?? 0) - (attn.get(a.imageId) ?? 0)
  );

  const top = ranked.slice(0, limit);
  const vectors = await Promise.all(top.map((r) => getCaptionVector(r.imageId)));

  return top.map((r, i) => ({
    imageId: r.imageId,
    slug: r.slug,
    handle: r.handle ?? null,
    blobUrl: r.blobUrl,
    generation: r.generation,
    fitness: attn.get(r.imageId) ?? 0,
    embedding: vectors[i],
    archivedAt: r.archivedAt
  }));
}

// getLowestFitnessActive(): active images ordered worst-fitness-first.
//
// This is the inverse of getFittestImages and backs population-cap culling: to
// keep the active population at or under a cap we archive the least fit image.
// Returns enough rows that the caller can skip any it must not archive (a
// parent of the current reproduction) and still find a valid victim. Only
// returns imageId + slug; the caller does not need embeddings to cull.
export async function getLowestFitnessActive(
  limit = 20
): Promise<{ imageId: number; slug: string; fitness: number }[]> {
  const cap = Math.min(Math.max(Math.trunc(limit), 1), 200);
  // Scan a generous active pool, score by decayed attention, take the worst.
  // ascending uploadedAt as the pool order so that among zero-attention images
  // the OLDEST surface first (oldest unviewed is the most natural cull target).
  const POOL = Math.max(cap * 5, 100);
  const baseRows = await db
    .select({
      imageId: images.id,
      slug: images.slug
    })
    .from(images)
    .where(isNull(images.archivedAt))
    .orderBy(images.uploadedAt, images.id)
    .limit(POOL);

  if (baseRows.length === 0) return [];

  const attn = await getDecayedAttentionMap(baseRows.map((r) => r.imageId));
  const ranked = [...baseRows].sort(
    (a, b) => (attn.get(a.imageId) ?? 0) - (attn.get(b.imageId) ?? 0)
  );
  return ranked
    .slice(0, cap)
    .map((r) => ({ imageId: r.imageId, slug: r.slug, fitness: attn.get(r.imageId) ?? 0 }));
}

export type PopulationStats = {
  total: number;
  archived: number;
  active: number;
  maxGeneration: number;
};

export async function getPopulationStats(): Promise<PopulationStats> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      archived: sql<number>`count(*) FILTER (WHERE ${images.archivedAt} IS NOT NULL)::int`,
      active: sql<number>`count(*) FILTER (WHERE ${images.archivedAt} IS NULL)::int`,
      // coalesce so an empty table reports 0, not null.
      maxGeneration: sql<number>`coalesce(max(${images.generation}), 0)::int`
    })
    .from(images);
  return {
    total: Number(row?.total ?? 0),
    archived: Number(row?.archived ?? 0),
    active: Number(row?.active ?? 0),
    maxGeneration: Number(row?.maxGeneration ?? 0)
  };
}

// Count of currently-active (non-archived) images. Used by the population-cap
// check in the reproduce route before deciding whether to cull.
export async function countActiveImages(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(images)
    .where(isNull(images.archivedAt));
  return Number(row?.n ?? 0);
}

// archiveImage(): SAFETY -- this NEVER hard-deletes. It stamps archived_at so
// the row vanishes from public surfaces (buildVisibilityPredicate filters
// archivedAt IS NOT NULL) while every byte, caption, embedding, reaction, and
// lineage edge stays intact and recoverable via unarchiveImage. There is
// deliberately no DELETE anywhere in this module.
export async function archiveImage(imageId: number): Promise<{ imageId: number; slug: string } | null> {
  const [row] = await db
    .update(images)
    .set({ archivedAt: new Date() })
    .where(and(eq(images.id, imageId), isNull(images.archivedAt)))
    .returning({ imageId: images.id, slug: images.slug });
  return row ?? null;
}

// unarchiveImage(): the reversal. Clears archived_at so the row returns to
// public surfaces. Idempotent: re-running on an already-active row is a no-op
// that still returns the row.
export async function unarchiveImage(imageId: number): Promise<{ imageId: number; slug: string } | null> {
  const [row] = await db
    .update(images)
    .set({ archivedAt: null })
    .where(eq(images.id, imageId))
    .returning({ imageId: images.id, slug: images.slug });
  return row ?? null;
}

// recordLineage(): insert child->parent edges (one per parent) into
// image_lineage. The unique (child_image_id, parent_image_id) index means a
// re-run is a no-op via onConflictDoNothing rather than an error. parentBId is
// optional so a single-parent edge is expressible, though reproduction always
// passes two.
export async function recordLineage(
  childId: number,
  parentAId: number,
  parentBId?: number,
  promptUsed?: string
): Promise<void> {
  const rows = [
    { childImageId: childId, parentImageId: parentAId, promptUsed: promptUsed ?? null }
  ];
  if (parentBId != null && parentBId !== parentAId) {
    rows.push({ childImageId: childId, parentImageId: parentBId, promptUsed: promptUsed ?? null });
  }
  await db.insert(imageLineage).values(rows).onConflictDoNothing();
}

export type LineageRelative = {
  imageId: number;
  slug: string;
  blobUrl: string;
  generation: number;
};

export type LineageListing = {
  parents: LineageRelative[];
  children: LineageRelative[];
};

// listLineage(): direct parents and direct children of an image, for a
// family-tree view. One hop in each direction (the /lineage graph route walks
// the full component; this is the focused per-image listing).
export async function listLineage(imageId: number): Promise<LineageListing> {
  const [parentEdges, childEdges] = await Promise.all([
    db
      .select({ parentImageId: imageLineage.parentImageId })
      .from(imageLineage)
      .where(eq(imageLineage.childImageId, imageId)),
    db
      .select({ childImageId: imageLineage.childImageId })
      .from(imageLineage)
      .where(eq(imageLineage.parentImageId, imageId))
  ]);

  const parentIds = parentEdges.map((e) => e.parentImageId);
  const childIds = childEdges.map((e) => e.childImageId);

  const hydrate = async (ids: number[]): Promise<LineageRelative[]> => {
    if (ids.length === 0) return [];
    const rows = await db
      .select({
        imageId: images.id,
        slug: images.slug,
        blobUrl: images.blobUrl,
        generation: images.generation
      })
      .from(images)
      .where(inArray(images.id, ids));
    return rows.map((r) => ({
      imageId: r.imageId,
      slug: r.slug,
      blobUrl: r.blobUrl,
      generation: r.generation
    }));
  };

  const [parents, children] = await Promise.all([hydrate(parentIds), hydrate(childIds)]);
  return { parents, children };
}

// isParentOf(): guard for population-cap culling. Returns true if candidate is
// a direct parent of child. The cap enforcement uses this to refuse to archive
// a parent of the image just born (see the reproduce route).
export async function isParentOf(candidateId: number, childId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: imageLineage.id })
    .from(imageLineage)
    .where(
      and(eq(imageLineage.childImageId, childId), eq(imageLineage.parentImageId, candidateId))
    )
    .limit(1);
  return !!row;
}
