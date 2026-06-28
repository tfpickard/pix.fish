import { asc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../client';
import { loreFragments, type LoreFragment, type NewLoreFragment } from '../schema';

// PROJECTION helpers for lore fragments -- the individual signed pieces that
// make up dossiers. Each fragment is embedded (a matching embeddings row with
// subject_type='lore') and carries coords inherited from its parent image.

// Upsert keyed on the originating event, so a rebuild that replays the same
// intake event lands the same fragment row (and the caller can re-attach its
// embedding). Returns the fragment id.
export async function upsertLoreFragment(input: NewLoreFragment): Promise<number> {
  const [row] = await db
    .insert(loreFragments)
    .values(input)
    .onConflictDoUpdate({
      target: loreFragments.eventId,
      set: {
        specimenImageId: input.specimenImageId,
        clerkSlug: input.clerkSlug,
        kind: input.kind ?? 'intake',
        body: input.body,
        sources: input.sources ?? [],
        x: input.x ?? null,
        y: input.y ?? null,
        z: input.z ?? null,
        createdAt: input.createdAt ?? new Date()
      }
    })
    .returning({ id: loreFragments.id });
  return row!.id;
}

// All fragments filed against a specimen, oldest first -- the dossier's
// chronological record. The latest is the current case file; the rest are the
// amendment history.
export async function listLoreFragments(imageId: number): Promise<LoreFragment[]> {
  return db
    .select()
    .from(loreFragments)
    .where(eq(loreFragments.specimenImageId, imageId))
    .orderBy(asc(loreFragments.createdAt), asc(loreFragments.id));
}

export async function countLoreFragmentsForImage(imageId: number): Promise<number> {
  const res = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM lore_fragments WHERE specimen_image_id = ${imageId}`
  );
  return Number(res.rows?.[0]?.n ?? 0);
}

// Count of amendment fragments for a specimen. The reducer derives the
// specimen's generation from this (rather than a read-modify-write of
// generation), so concurrent or repeated materializations converge to the same
// value instead of drifting above the canon event count.
export async function countAmendmentFragments(imageId: number): Promise<number> {
  const res = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM lore_fragments WHERE specimen_image_id = ${imageId} AND kind = 'amendment'`
  );
  return Number(res.rows?.[0]?.n ?? 0);
}

export async function countImagesWithLoreFragments(): Promise<number> {
  const res = await db.execute<{ n: number }>(
    sql`SELECT count(DISTINCT specimen_image_id)::int AS n FROM lore_fragments`
  );
  return Number(res.rows?.[0]?.n ?? 0);
}

export type LoreSummary = { imageId: number; fragments: number };

// Fragment counts per image for a set of ids. Used by the map/manifold lore
// layer to size each specimen's marker by how thick its dossier has grown.
// Images with no lore are simply absent from the returned map.
export async function loreSummaryByImageIds(ids: number[]): Promise<Map<number, LoreSummary>> {
  const out = new Map<number, LoreSummary>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ imageId: loreFragments.specimenImageId, n: sql<number>`count(*)::int` })
    .from(loreFragments)
    .where(inArray(loreFragments.specimenImageId, ids))
    .groupBy(loreFragments.specimenImageId);
  for (const r of rows) {
    out.set(r.imageId, { imageId: r.imageId, fragments: Number(r.n) });
  }
  return out;
}

// Rebuild support. DELETE cascades to the fragments' lore embeddings via the
// embeddings.lore_fragment_id FK, so this clears both in one step.
export async function deleteAllLoreFragments(): Promise<void> {
  await db.delete(loreFragments);
}
