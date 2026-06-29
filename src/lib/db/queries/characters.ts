import { asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../client';
import {
  characterAppearances,
  characters,
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

// Rebuild support: a census clears and replaces, so the reducer wipes these
// before writing the newest roster. DELETE (not TRUNCATE) to respect FKs.
export async function deleteAllCharacters(): Promise<void> {
  await db.delete(characters);
}

export async function deleteAllAppearances(): Promise<void> {
  await db.delete(characterAppearances);
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
