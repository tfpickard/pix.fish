import { allCropVectors, type CropVector } from '@/lib/db/queries/character-crops';
import { writeCandidates, deleteCandidatesForRun } from '@/lib/db/queries/character-candidates';
import { getTuning, type ClusterSpace } from '@/lib/db/queries/character-tuning';
import { nextClusterRunStamp } from '@/lib/db/queries/events';
import { enqueueJob } from '@/lib/db/queries/jobs';
import type { Job } from '@/lib/db/schema';
import { buildCropEdges, cropClusterVector } from '@/lib/universe/characters';
import { detectCommunities } from '@/lib/universe/cluster';
import { clusterReadiness } from '@/lib/universe/visual-coverage';

type Payload = {
  runStamp?: number;
  minAppearances?: number;
  maxDist?: number;
  k?: number;
  pruneK?: number;
  verifyEnabled?: boolean;
  space?: ClusterSpace;
  blendWeight?: number;
  partialOk?: boolean; // cluster on a non-text space even if some crops lack the vec
  stamp?: number; // legacy alias for runStamp
};

export type ResolvedKnobs = {
  runStamp: number;
  minAppearances: number;
  maxDist: number;
  k: number;
  pruneK: number;
  verifyEnabled: boolean;
  space: ClusterSpace;
  blendWeight: number;
  partialOk: boolean;
};

// Coverage was incomplete for the chosen space. A distinct type because this is
// a STATE, not a fault: the queue handler treats it as a skip while the offline
// pipeline still fails loudly. Deliberately NOT used for the harder guard below
// (a corpus where no crop has the vector at all) -- that one is a genuine
// misconfiguration and should stay noisy wherever it is raised.
export class PartialCoverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PartialCoverageError';
  }
}

// Use a payload number only when it's finite; otherwise fall back to the saved
// tuning. Guards against NaN sneaking in from CLI parsing (e.g. --maxDist=abc),
// which would otherwise poison the knobs and silently filter out all candidates.
function num(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// Resolve the effective knobs from a payload, falling back to the saved tuning.
export async function resolveKnobs(payload: Payload): Promise<ResolvedKnobs> {
  const tuning = await getTuning();
  // When no stamp is supplied (the offline characters-detect.ts path), allocate a
  // monotonic one instead of `Date.now() % int4`. Census stamps are now full
  // millisecond values, so a modulo'd fallback lands far below the latest census
  // and assembleCensus() would treat the run as stale -- deleting its candidates
  // and skipping the roster update. Only hit the DB when we actually need it.
  const provided = payload.runStamp ?? payload.stamp;
  const runStamp =
    typeof provided === 'number' && Number.isFinite(provided) ? provided : await nextClusterRunStamp();
  return {
    runStamp,
    minAppearances: Math.max(2, Math.trunc(num(payload.minAppearances, tuning.minAppearances))),
    maxDist: num(payload.maxDist, tuning.maxDist),
    k: Math.max(1, Math.trunc(num(payload.k, tuning.k))),
    pruneK: Math.max(1, Math.trunc(num(payload.pruneK, tuning.pruneK))),
    verifyEnabled: payload.verifyEnabled ?? tuning.verifyEnabled,
    space: payload.space ?? tuning.space,
    blendWeight: num(payload.blendWeight, tuning.blendWeight),
    partialOk: payload.partialOk ?? false
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

  // Build the cluster vector for the chosen space; drop crops missing the needed
  // vector (e.g. visual/blend before the crops are backfilled).
  const nodes: { cropId: number; vec: number[] }[] = [];
  let skipped = 0;
  for (const c of crops) {
    const v = cropClusterVector(c, knobs.space, knobs.blendWeight);
    if (v) nodes.push({ cropId: c.cropId, vec: v });
    else skipped++;
  }
  if (skipped > 0) {
    console.log(
      `characters.cluster: ${skipped}/${crops.length} crop(s) lack a ${knobs.space} vector` +
        (knobs.space !== 'text' ? ' -- run characters:backfill-visuals' : '')
    );
  }

  // Guard against a destructive misconfiguration: crops exist but NONE have a
  // vector for the chosen space (e.g. switched to visual/blend before backfilling
  // vec_image). Proceeding would file an empty census and WIPE the existing
  // roster. Abort loudly instead -- no census is enqueued, so the canon survives.
  if (crops.length > 0 && nodes.length === 0) {
    throw new Error(
      `characters.cluster: none of the ${crops.length} crop(s) have a '${knobs.space}' vector. ` +
        `Run 'characters:backfill-visuals' (needs VOYAGE_API_KEY) or switch the identity space back ` +
        `to 'text'. Aborting -- NOT filing an empty census, so the existing roster is preserved.`
    );
  }

  // Partial coverage on a non-text space is also destructive: clustering only the
  // embedded subset builds a roster missing any character seen only in skipped
  // crops, and the census reducer then prunes those characters from the live
  // canon. Abort unless the caller explicitly opts into a partial census. (A
  // blend at weight 0 is effectively text and skips nothing, so it won't trip.)
  if (knobs.space !== 'text' && skipped > 0 && !knobs.partialOk) {
    throw new PartialCoverageError(
      `characters.cluster: ${skipped}/${crops.length} crop(s) lack a '${knobs.space}' vector. ` +
        `Finish 'characters:backfill-visuals' first, or pass partialOk to cluster on the embedded ` +
        `subset. Aborting so a partial roster doesn't prune characters from the canon.`
    );
  }

  const communities =
    nodes.length >= 2
      ? detectCommunities(
          nodes.map((n) => n.cropId),
          buildCropEdges(nodes, knobs.k, knobs.maxDist),
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

  // Re-check coverage against the knobs this run actually resolved, not the ones
  // the enqueuer checked. Every enqueue path verifies readiness first, but that
  // verdict can go stale before the job runs: scheduleRecluster debounces by two
  // minutes, the cron's job waits for a drain slot, and in between an admin can
  // switch the saved space to visual/blend while coverage is incomplete. The
  // payload carries no knobs in those paths, so resolveKnobs picks up the NEW
  // tuning and the run aborts -- the red job every enqueue path exists to avoid.
  //
  // Re-checking here rather than pinning the tuning into the payload: pinning
  // would make a debounced run silently cluster with knobs the admin has since
  // changed, which is a worse answer than not clustering. partialOk still
  // overrides, and a skip is a no-op -- nothing is staged, so there is nothing
  // to clean up and no census to strand.
  if (!knobs.partialOk) {
    const readiness = await clusterReadiness({
      space: knobs.space,
      blendWeight: knobs.blendWeight
    });
    if (!readiness.ready) {
      console.log(`characters.cluster: skipping -- ${readiness.blocker}`);
      return;
    }
  }

  // The readiness check above is a fast path, not the authority: it counts crops
  // in its own query, and characters.detect can insert a new text-only crop in
  // the gap before produceCandidates loads them. Cluster jobs run with
  // maxAttempts:1, so an ordinary overlapping detection would turn straight into
  // the red job this whole change exists to prevent. produceCandidates decides
  // from the SAME snapshot it clusters, so let its verdict be final and treat
  // partial coverage as the skip it is. Nothing is staged before that guard, so
  // there is nothing to unwind -- and the detection that caused it schedules its
  // own recluster once the backfill catches up.
  let count: number;
  try {
    count = await produceCandidates(knobs);
  } catch (err) {
    if (err instanceof PartialCoverageError) {
      console.log(`characters.cluster: skipping -- ${err.message}`);
      return;
    }
    throw err;
  }

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
