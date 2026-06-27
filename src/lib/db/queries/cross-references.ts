import { asc, eq, sql } from 'drizzle-orm';
import { db } from '../client';
import { crossReferences, images, type NewCrossReference } from '../schema';

// PROJECTION helpers for cross-references -- the archive's formal record of
// which specimens it has linked, materialized from cross_reference.filed
// events (themselves derived from the image kNN graph at intake).

export async function upsertCrossReference(input: NewCrossReference): Promise<void> {
  await db
    .insert(crossReferences)
    .values(input)
    .onConflictDoUpdate({
      target: [crossReferences.srcImageId, crossReferences.dstImageId, crossReferences.kind],
      set: { dist: input.dist ?? null, createdAt: input.createdAt ?? new Date() }
    });
}

export type CrossReferenceLink = {
  dstImageId: number;
  dstSlug: string;
  dist: number | null;
  kind: string;
};

// Outgoing cross-references for a specimen, with the destination slug so the
// detail page can link straight to the referenced case file. Ordered by
// distance (closest first) so the strongest links lead.
export async function listCrossReferences(imageId: number): Promise<CrossReferenceLink[]> {
  const rows = await db
    .select({
      dstImageId: crossReferences.dstImageId,
      dstSlug: images.slug,
      dist: crossReferences.dist,
      kind: crossReferences.kind
    })
    .from(crossReferences)
    .innerJoin(images, eq(images.id, crossReferences.dstImageId))
    .where(eq(crossReferences.srcImageId, imageId))
    .orderBy(asc(crossReferences.dist));
  return rows.map((r) => ({
    dstImageId: r.dstImageId,
    dstSlug: r.dstSlug,
    dist: r.dist,
    kind: r.kind
  }));
}

export async function countCrossReferences(): Promise<number> {
  const res = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM cross_references`
  );
  return Number(res.rows?.[0]?.n ?? 0);
}

export async function deleteAllCrossReferences(): Promise<void> {
  await db.delete(crossReferences);
}
