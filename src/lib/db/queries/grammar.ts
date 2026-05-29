import { and, eq, sql } from 'drizzle-orm';
import { db } from '../client';
import { grammarFillers, grammarSlots } from '../schema';
import type { GrammarFiller, GrammarSlot } from '../schema';

export async function listSlots(ownerId: string): Promise<GrammarSlot[]> {
  return db
    .select()
    .from(grammarSlots)
    .where(eq(grammarSlots.ownerId, ownerId))
    .orderBy(sql`${grammarSlots.frequency} DESC`, grammarSlots.id);
}

export async function listFillers(ownerId: string): Promise<GrammarFiller[]> {
  return db
    .select()
    .from(grammarFillers)
    .where(eq(grammarFillers.ownerId, ownerId))
    .orderBy(grammarFillers.slotName, sql`${grammarFillers.weight} DESC`, grammarFillers.id);
}

export async function upsertSlot(input: {
  ownerId: string;
  template: string;
  frequency: number;
  version?: number;
}): Promise<void> {
  await db
    .insert(grammarSlots)
    .values({
      ownerId: input.ownerId,
      template: input.template,
      frequency: input.frequency,
      version: input.version ?? 1
    })
    .onConflictDoUpdate({
      target: [grammarSlots.ownerId, grammarSlots.template],
      set: { frequency: input.frequency, version: input.version ?? 1 }
    });
}

export async function upsertFiller(input: {
  ownerId: string;
  slotName: string;
  filler: string;
  weight: number;
  version?: number;
}): Promise<void> {
  await db
    .insert(grammarFillers)
    .values({
      ownerId: input.ownerId,
      slotName: input.slotName,
      filler: input.filler,
      weight: input.weight,
      version: input.version ?? 1
    })
    .onConflictDoUpdate({
      target: [grammarFillers.ownerId, grammarFillers.slotName, grammarFillers.filler],
      set: { weight: input.weight, version: input.version ?? 1 }
    });
}

// Replace the whole grammar artifact for one owner. Used by derive-grammar
// so an owner's previous run doesn't leave stale templates/fillers behind
// when the new run produces a smaller set.
export async function clearGrammar(ownerId: string): Promise<void> {
  await db.delete(grammarFillers).where(eq(grammarFillers.ownerId, ownerId));
  await db.delete(grammarSlots).where(eq(grammarSlots.ownerId, ownerId));
}

// Bulk insert variants used by derive-grammar. Drops the existing rows for
// the owner first, then inserts everything in one batch -- ~50x faster
// than the per-row upsert flow when the corpus produces thousands of
// fillers over a Neon serverless connection.
export async function bulkInsertSlots(
  ownerId: string,
  rows: { template: string; frequency: number; version?: number }[]
): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(grammarSlots).values(
    rows.map((r) => ({
      ownerId,
      template: r.template,
      frequency: r.frequency,
      version: r.version ?? 1
    }))
  );
}

export async function bulkInsertFillers(
  ownerId: string,
  rows: { slotName: string; filler: string; weight: number; version?: number }[]
): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(grammarFillers).values(
    rows.map((r) => ({
      ownerId,
      slotName: r.slotName,
      filler: r.filler,
      weight: r.weight,
      version: r.version ?? 1
    }))
  );
}

// Slot-name index for the skeleton sampler: { slotName -> [{ filler, weight }] }
export type FillerBySlot = Record<string, { filler: string; weight: number }[]>;

export function indexFillers(fillers: GrammarFiller[]): FillerBySlot {
  const out: FillerBySlot = {};
  for (const f of fillers) {
    const list = out[f.slotName] ?? (out[f.slotName] = []);
    list.push({ filler: f.filler, weight: f.weight });
  }
  return out;
}

export async function loadGrammar(ownerId: string): Promise<{
  slots: GrammarSlot[];
  fillersBySlot: FillerBySlot;
}> {
  const [slots, fillers] = await Promise.all([listSlots(ownerId), listFillers(ownerId)]);
  return { slots, fillersBySlot: indexFillers(fillers) };
}

// Convenience used by the dev / health surface so the playground page can
// say "no grammar yet, run scripts/derive-grammar.ts" when empty.
export async function hasAnyGrammar(ownerId: string): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(grammarSlots)
    .where(eq(grammarSlots.ownerId, ownerId));
  return (row?.n ?? 0) > 0;
}

// Single-row helpers kept around in case the admin UI ever wants direct
// edits without going through derive.
export async function deleteFiller(ownerId: string, id: number): Promise<void> {
  await db
    .delete(grammarFillers)
    .where(and(eq(grammarFillers.ownerId, ownerId), eq(grammarFillers.id, id)));
}

export async function deleteSlot(ownerId: string, id: number): Promise<void> {
  await db
    .delete(grammarSlots)
    .where(and(eq(grammarSlots.ownerId, ownerId), eq(grammarSlots.id, id)));
}
