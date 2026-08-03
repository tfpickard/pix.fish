import { imageVecCoverage, MAX_IMAGE_EMBED_ATTEMPTS } from '@/lib/db/queries/character-crops';
import { getTuning, type ClusterSpace } from '@/lib/db/queries/character-tuning';
import { spaceNeedsVisual } from '@/lib/universe/characters';

// Can a clustering run actually succeed right now?
//
// characters.cluster aborts when the chosen identity space needs a visual vector
// that some crops lack, because clustering the embedded subset would file a
// partial census and prune the missing characters out of the canon. That abort
// is correct -- but enqueuing a run that is KNOWN to hit it just manufactures a
// failed job on every cron tick while the roster silently stops updating. So
// every enqueue path asks this first and either fixes the coverage or reports
// the blocker, instead of firing a doomed job.

export type ClusterReadiness = {
  space: ClusterSpace;
  // Whether this space needs a visual vector at all. Text -- and a blend
  // weighted entirely to text -- never skip a crop, so they are always ready.
  needsVisual: boolean;
  // Crops with no visual vector that the backfill will still retry.
  retriable: number;
  // Crops with no visual vector that the backfill has given up on.
  abandoned: number;
  // Crops that DO have a visual vector. Zero means even a partialOk run is
  // doomed: produceCandidates hard-aborts on a nonempty corpus with no usable
  // nodes, and that guard has no override -- filing an empty census would wipe
  // the roster outright.
  embedded: number;
  ready: boolean;
  // Operator-facing sentence naming the blocker and the way out. Null when ready.
  blocker: string | null;
};

export async function clusterReadiness(): Promise<ClusterReadiness> {
  const tuning = await getTuning();
  const needsVisual = spaceNeedsVisual(tuning.space, tuning.blendWeight);
  if (!needsVisual) {
    return {
      space: tuning.space,
      needsVisual: false,
      retriable: 0,
      abandoned: 0,
      embedded: 0, // not consulted for a text space; nothing can be missing
      ready: true,
      blocker: null
    };
  }

  // One snapshot, not separate counts: the backfill increments the column these
  // are partitioned on, so independent reads can miss a crop crossing the cap
  // between them and report full coverage for a corpus that has none.
  const { retriable, abandoned, embedded } = await imageVecCoverage();

  if (retriable === 0 && abandoned === 0) {
    return {
      space: tuning.space,
      needsVisual,
      retriable,
      abandoned,
      embedded,
      ready: true,
      blocker: null
    };
  }

  // Two blockers, two different actions. Retriable crops fix themselves once the
  // backfill drains, so say so and say nothing else. Abandoned crops never will,
  // so name the choices instead of leaving the operator to infer them.
  const blocker =
    abandoned > 0
      ? `${abandoned} crop(s) can no longer be embedded (gave up after ${MAX_IMAGE_EMBED_ATTEMPTS} ` +
        `attempts each)${retriable > 0 ? ` and ${retriable} more are still draining` : ''}. ` +
        `Clustering in '${tuning.space}' would drop them and prune their characters from the canon. ` +
        `Fix by force re-detecting the affected images (re-cuts the crops), releasing the attempt ` +
        `cap once the cause is fixed, or moving the identity space back to 'text'.`
      : `${retriable} crop(s) still lack a visual vector; the backfill is draining them. ` +
        `Clustering resumes automatically once coverage is complete.`;

  return { space: tuning.space, needsVisual, retriable, abandoned, embedded, ready: false, blocker };
}
