import { and, asc, desc, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  characterAppearances,
  characters,
  images,
  type Character,
  type NewCharacter,
  type NewCharacterAppearance
} from '../schema';

// PROJECTION helpers for recurring characters. Materialized from the latest
// character.census event (see reduce.ts). Identity is interpretation, so a new
// census clears and replaces these tables; the detail/gallery pages read here.

export async function upsertCharacter(input: NewCharacter): Promise<void> {
  await db
    .insert(characters)
    .values(input)
    .onConflictDoUpdate({
      target: characters.key,
      set: {
        name: input.name,
        dossier: input.dossier,
        clerkSlug: input.clerkSlug,
        canonicalCropUrl: input.canonicalCropUrl ?? null,
        appearanceCount: input.appearanceCount ?? 0,
        censusEventId: input.censusEventId,
        generation: input.generation ?? 0,
        createdAt: input.createdAt ?? new Date()
      }
    });
}

export async function insertAppearance(input: NewCharacterAppearance): Promise<void> {
  await db
    .insert(characterAppearances)
    .values(input)
    .onConflictDoUpdate({
      target: [characterAppearances.characterKey, characterAppearances.imageId],
      set: { cropUrl: input.cropUrl ?? null, box: input.box ?? null, createdAt: input.createdAt ?? new Date() }
    });
}

export async function listCharacters(): Promise<Character[]> {
  return db.select().from(characters).orderBy(desc(characters.appearanceCount), asc(characters.key));
}

// Gallery view: only characters with at least one publicly-visible appearance
// for the viewer's NSFW mode, and with appearanceCount reflecting just those
// visible appearances (so the gallery count matches the detail page). A
// character whose every appearance is NSFW/archived is omitted entirely.
export async function listVisibleCharacters(opts: {
  nsfwMode: 'hide' | 'include' | 'only';
}): Promise<Character[]> {
  const nsfwCond =
    opts.nsfwMode === 'hide'
      ? eq(images.isNsfw, false)
      : opts.nsfwMode === 'only'
        ? eq(images.isNsfw, true)
        : undefined;
  const visibleCount = sql<number>`count(${characterAppearances.imageId})::int`;
  // Headshot must come from a VISIBLE appearance: the stored canonicalCropUrl can
  // point at a crop whose source image was since deleted/hidden. Keep the stored
  // canonical when it's still among the visible crops, else fall back to the
  // first visible crop by image id (null if none has a crop url).
  const visibleCanonical = sql<string | null>`coalesce(
    max(${characters.canonicalCropUrl}) FILTER (WHERE ${characterAppearances.cropUrl} = ${characters.canonicalCropUrl}),
    (array_agg(${characterAppearances.cropUrl} ORDER BY ${characterAppearances.imageId})
       FILTER (WHERE ${characterAppearances.cropUrl} IS NOT NULL))[1]
  )`;
  const rows = await db
    .select({
      key: characters.key,
      name: characters.name,
      dossier: characters.dossier,
      clerkSlug: characters.clerkSlug,
      canonicalCropUrl: visibleCanonical,
      censusEventId: characters.censusEventId,
      generation: characters.generation,
      createdAt: characters.createdAt,
      visibleCount
    })
    .from(characters)
    .innerJoin(characterAppearances, eq(characterAppearances.characterKey, characters.key))
    .innerJoin(images, eq(images.id, characterAppearances.imageId))
    .where(and(isNull(images.archivedAt), nsfwCond))
    .groupBy(characters.key)
    .orderBy(desc(visibleCount), asc(characters.key));
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    dossier: r.dossier,
    clerkSlug: r.clerkSlug,
    canonicalCropUrl: r.canonicalCropUrl,
    appearanceCount: r.visibleCount,
    censusEventId: r.censusEventId,
    generation: r.generation,
    createdAt: r.createdAt
  }));
}

export async function getCharacter(key: string): Promise<Character | null> {
  const [row] = await db.select().from(characters).where(eq(characters.key, key)).limit(1);
  return row ?? null;
}

export type AppearanceRow = {
  imageId: number;
  cropUrl: string | null;
  box: { left: number; top: number; width: number; height: number } | null;
};

export async function listAppearances(characterKey: string): Promise<AppearanceRow[]> {
  const rows = await db
    .select({
      imageId: characterAppearances.imageId,
      cropUrl: characterAppearances.cropUrl,
      box: characterAppearances.box
    })
    .from(characterAppearances)
    .where(eq(characterAppearances.characterKey, characterKey))
    .orderBy(asc(characterAppearances.imageId));
  return rows.map((r) => ({ imageId: r.imageId, cropUrl: r.cropUrl, box: r.box }));
}

export type CharacterBadge = { key: string; name: string; cropUrl: string | null };

// The characters detected in a given image, for the specimen "recurring
// subjects" section. Joins appearances -> characters.
export async function charactersForImage(imageId: number): Promise<CharacterBadge[]> {
  const rows = await db
    .select({
      key: characters.key,
      name: characters.name,
      cropUrl: characterAppearances.cropUrl
    })
    .from(characterAppearances)
    .innerJoin(characters, eq(characters.key, characterAppearances.characterKey))
    .where(eq(characterAppearances.imageId, imageId))
    .orderBy(desc(characters.appearanceCount));
  return rows.map((r) => ({ key: r.key, name: r.name, cropUrl: r.cropUrl }));
}

export async function countCharacters(): Promise<number> {
  const res = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM characters`);
  return Number(res.rows?.[0]?.n ?? 0);
}

// Image ids referenced by appearances -- the verify script uses this to
// reconcile cross-references against the specimen set.
export async function appearanceImageIds(): Promise<number[]> {
  const rows = await db
    .selectDistinct({ imageId: characterAppearances.imageId })
    .from(characterAppearances);
  return rows.map((r) => r.imageId);
}

// Rebuild support: a full rebuild wipes these before replaying the log. DELETE
// (not TRUNCATE) to respect FKs.
export async function deleteAllCharacters(): Promise<void> {
  await db.delete(characters);
}

export async function deleteAllAppearances(): Promise<void> {
  await db.delete(characterAppearances);
}

// Census write-then-prune support. The HTTP DB driver has no multi-statement
// transaction, so applying a census as "clear all, then repopulate" risks
// leaving the projection empty if the process dies mid-apply. Instead the
// reducer upserts the new roster first, then prunes whatever isn't in it --
// the projection is never blank, and a re-apply converges to the same rows.

// Drop appearances of a character that aren't in its newest appearance set.
export async function pruneAppearancesForCharacter(
  characterKey: string,
  keepImageIds: number[]
): Promise<void> {
  if (keepImageIds.length === 0) {
    await db.delete(characterAppearances).where(eq(characterAppearances.characterKey, characterKey));
    return;
  }
  await db
    .delete(characterAppearances)
    .where(
      and(
        eq(characterAppearances.characterKey, characterKey),
        notInArray(characterAppearances.imageId, keepImageIds)
      )
    );
}

// Drop characters (and their appearances -- no FK cascade on character_key)
// whose key isn't in the newest census roster. An empty roster clears both.
export async function pruneCharactersNotIn(keepKeys: string[]): Promise<void> {
  if (keepKeys.length === 0) {
    await db.delete(characterAppearances);
    await db.delete(characters);
    return;
  }
  await db.delete(characterAppearances).where(notInArray(characterAppearances.characterKey, keepKeys));
  await db.delete(characters).where(notInArray(characters.key, keepKeys));
}

// Filter a set of appearance image ids down to publicly-visible specimens.
// Used by the character detail page to drop NSFW/archived appearances.
export async function visibleAppearanceImageIds(
  imageIds: number[],
  opts: { nsfwMode: 'hide' | 'include' | 'only' }
): Promise<Set<number>> {
  const out = new Set<number>();
  if (imageIds.length === 0) return out;
  const res = await db.execute<{ id: number }>(sql`
    SELECT id FROM images
    WHERE id IN (${sql.raw(imageIds.filter((n) => Number.isInteger(n)).join(',') || '-1')})
      AND archived_at IS NULL
      ${opts.nsfwMode === 'hide' ? sql`AND is_nsfw = false` : opts.nsfwMode === 'only' ? sql`AND is_nsfw = true` : sql``}
  `);
  for (const r of res.rows) out.add(Number(r.id));
  return out;
}
