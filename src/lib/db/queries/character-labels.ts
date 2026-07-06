import { asc, eq, sql } from 'drizzle-orm';
import { db } from '../client';
import { characterLabels, type CharacterLabel } from '../schema';

// Eval ground truth. An admin marks each materialized appearance correct/wrong;
// labels are keyed to a stable subjectLabel (not the volatile character-N key)
// so they survive re-clustering. scripts/eval-characters.ts scores against these.

export async function upsertLabel(
  subjectLabel: string,
  imageId: number,
  verdict: boolean
): Promise<void> {
  await db
    .insert(characterLabels)
    .values({ subjectLabel, imageId, verdict })
    .onConflictDoUpdate({
      target: [characterLabels.subjectLabel, characterLabels.imageId],
      set: { verdict, updatedAt: sql`now()` }
    });
}

export async function deleteLabel(subjectLabel: string, imageId: number): Promise<void> {
  await db
    .delete(characterLabels)
    .where(sql`${characterLabels.subjectLabel} = ${subjectLabel} AND ${characterLabels.imageId} = ${imageId}`);
}

export async function listLabels(): Promise<CharacterLabel[]> {
  return db.select().from(characterLabels).orderBy(asc(characterLabels.subjectLabel), asc(characterLabels.imageId));
}

export async function listLabelsForSubject(subjectLabel: string): Promise<CharacterLabel[]> {
  return db
    .select()
    .from(characterLabels)
    .where(eq(characterLabels.subjectLabel, subjectLabel))
    .orderBy(asc(characterLabels.imageId));
}

// Ground-truth clusters: subjectLabel -> the image ids that genuinely depict it
// (verdict = true). scripts/eval-characters.ts turns these into precision/recall.
export type TruthClusters = Map<string, { positives: Set<number>; negatives: Set<number> }>;

export async function truthClusters(): Promise<TruthClusters> {
  const rows = await listLabels();
  const out: TruthClusters = new Map();
  for (const r of rows) {
    let entry = out.get(r.subjectLabel);
    if (!entry) {
      entry = { positives: new Set(), negatives: new Set() };
      out.set(r.subjectLabel, entry);
    }
    (r.verdict ? entry.positives : entry.negatives).add(r.imageId);
  }
  return out;
}
