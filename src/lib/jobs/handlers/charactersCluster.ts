import { allCropVectors, type CropVector } from '@/lib/db/queries/character-crops';
import { writeCandidates, deleteCandidatesForRun } from '@/lib/db/queries/character-candidates';
import { getTuning } from '@/lib/db/queries/character-tuning';
import { enqueueJob } from '@/lib/db/queries/jobs';
import type { Job } from '@/lib/db/schema';
import { buildCropEdges } from '@/lib/universe/characters';
import { detectCommunities } from '@/lib/universe/cluster';

type Payload = {
  runStamp?: number;
  minAppearances?: number;
  maxDist?: number;
  k?: number;
  pruneK?: number;
  verifyEnabled?: boolean;
  stamp?: number; // legacy alias for runStamp
};

export type ResolvedKnobs = {
  runStamp: number;
  minAppearances: number;
  maxDist: number;
  k: number;
  pruneK: number;
  verifyEnabled: boolean;
};

// Resolve the effective knobs from a payload, falling back to the saved tuning.
export async function resolveKnobs(payload: Payload): Promise<ResolvedKnobs> {
  const tuning = await getTuning();
  return {
    runStamp: payload.runStamp ?? payload.stamp ?? Math.floor(Date.now() % 2_147_483_647),
    minAppearances: Math.max(2, Math.trunc(payload.minAppearances ?? tuning.minAppearances)),
    maxDist: payload.maxDist ?? tuning.maxDist,
    k: Math.max(1, Math.trunc(payload.k ?? tuning.k)),
    pruneK: Math.max(1, Math.trunc(payload.pruneK ?? tuning.pruneK)),
    verifyEnabled: payload.verifyEnabled ?? tuning.verifyEnabled
  };
}

// Core of stage 1, shared by the job handler and the offline pipeline. Clusters
// all crop description-embeddings into candidate communities (crop ids are the
// nodes), keeps those recurring across >= minAppearances distinct specimens, and
// stages them. Returns the candidate count. Vector-only -- no LLM, no blob I/O.
export async function produceCandidates(knobs: ResolvedKnobs): Promise<number> {
  await deleteCandidatesForRun(knobs.runStamp); // fresh run (idempotent re-run)

  const crops = await allCropVectors();
  const byCrop = new Map<number, CropVector>(crops.map((c) => [c.cropId, c]));

  const communities =
    crops.length >= 2
      ? detectCommunities(
          crops.map((c) => c.cropId),
          buildCropEdges(
            crops.map((c) => ({ cropId: c.cropId, vec: c.vec })),
            knobs.k,
            knobs.maxDist
          ),
          { pruneK: knobs.pruneK }
        )
      : [];

  const candidates = communities
    .map((c) => c.memberImageIds) // crop ids
    .filter((cropIds) => {
      const imageIds = new Set<number>();
      for (const id of cropIds) {
        const crop = byCrop.get(id);
        if (crop) imageIds.add(crop.imageId);
      }
      return imageIds.size >= knobs.minAppearances;
    });

  await writeCandidates(knobs.runStamp, candidates);
  console.log(
    `characters.cluster: ${candidates.length} candidate(s) from ${crops.length} crops ` +
      `(maxDist=${knobs.maxDist} k=${knobs.k} pruneK=${knobs.pruneK} minApp=${knobs.minAppearances} verify=${knobs.verifyEnabled})`
  );
  return candidates.length;
}

// Stage 1 job handler: produce candidates, then fan out one characters.verify per
// candidate (mosaic precision pass) plus a characters.census finalizer. The heavy
// LLM work happens in those downstream jobs so nothing overruns the per-job wall
// budget. When verify is off, skip straight to the finalizer (each candidate is
// treated as one group).
export async function charactersClusterHandler(job: Job): Promise<void> {
  const knobs = await resolveKnobs((job.payload ?? {}) as Payload);
  const count = await produceCandidates(knobs);

  if (knobs.verifyEnabled) {
    for (let i = 0; i < count; i++) {
      await enqueueJob({
        type: 'characters.verify',
        payload: { runStamp: knobs.runStamp, candidateIndex: i },
        maxAttempts: 2
      });
    }
  }
  await enqueueJob({
    type: 'characters.census',
    payload: { runStamp: knobs.runStamp, minAppearances: knobs.minAppearances, poll: 0 },
    runAt: new Date(Date.now() + 5_000), // let the first verify jobs become claimable
    maxAttempts: 3
  });
}
