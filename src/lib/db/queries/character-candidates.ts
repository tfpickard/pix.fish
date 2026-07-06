import { and, asc, eq } from 'drizzle-orm';
import { db } from '../client';
import { characterCandidates, type CharacterCandidate } from '../schema';

// STAGING for the clustering pipeline. characters.cluster writes one row per
// candidate community; characters.verify fills verifiedGroups; characters.census
// reads them and clears the run. See src/lib/jobs/handlers/charactersCluster.ts.

export async function writeCandidates(
  runStamp: number,
  candidates: number[][] // each is a list of crop ids
): Promise<void> {
  if (candidates.length === 0) return;
  await db.insert(characterCandidates).values(
    candidates.map((cropIds, i) => ({
      runStamp,
      candidateIndex: i,
      cropIds
    }))
  );
}

export async function getCandidate(
  runStamp: number,
  candidateIndex: number
): Promise<CharacterCandidate | null> {
  const [row] = await db
    .select()
    .from(characterCandidates)
    .where(and(eq(characterCandidates.runStamp, runStamp), eq(characterCandidates.candidateIndex, candidateIndex)))
    .limit(1);
  return row ?? null;
}

export async function listCandidates(runStamp: number): Promise<CharacterCandidate[]> {
  return db
    .select()
    .from(characterCandidates)
    .where(eq(characterCandidates.runStamp, runStamp))
    .orderBy(asc(characterCandidates.candidateIndex));
}

// Store the mosaic-verified subgroups (each a same-individual crop-id group).
export async function setVerifiedGroups(
  runStamp: number,
  candidateIndex: number,
  groups: number[][]
): Promise<void> {
  await db
    .update(characterCandidates)
    .set({ verifiedGroups: groups, verifiedAt: new Date() })
    .where(and(eq(characterCandidates.runStamp, runStamp), eq(characterCandidates.candidateIndex, candidateIndex)));
}

export async function deleteCandidatesForRun(runStamp: number): Promise<void> {
  await db.delete(characterCandidates).where(eq(characterCandidates.runStamp, runStamp));
}
