import { getImageEmbedder } from '@/lib/ai/imageEmbed';
import { imageVecCoverage, MAX_IMAGE_EMBED_ATTEMPTS } from '@/lib/db/queries/character-crops';
import { getTuning, type ClusterSpace } from '@/lib/db/queries/character-tuning';
import { hasInFlightJobOfType } from '@/lib/db/queries/jobs';
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
  // Whether a VOYAGE_API_KEY exists at all. Without one nothing can ever be
  // embedded, so retriable crops are not "draining" -- they are stuck, and every
  // path that would drain them (cron, admin POST) refuses outright.
  embedderConfigured: boolean;
  // Whether a backfill is actually queued or running. `retriable > 0` alone says
  // a crop COULD be retried, not that anything is going to retry it: the chain
  // may have died with no successor. Callers that promise "this resolves itself"
  // -- notably the admin panel's poll loop -- must key off this, or they promise
  // a completion that will never come.
  backfillInFlight: boolean;
  ready: boolean;
  // Operator-facing sentence naming the blocker and the way out. Null when ready.
  blocker: string | null;
};

// `override` pins the check to knobs the caller has already resolved, rather
// than re-reading the saved tuning. A queued cluster carries its own resolved
// space (and may differ from the saved one entirely, e.g. an admin run), so
// asking about the saved tuning would answer a question nobody asked.
export async function clusterReadiness(
  override?: { space: ClusterSpace; blendWeight: number }
): Promise<ClusterReadiness> {
  const tuning = override ?? (await getTuning());
  const needsVisual = spaceNeedsVisual(tuning.space, tuning.blendWeight);
  if (!needsVisual) {
    return {
      space: tuning.space,
      needsVisual: false,
      retriable: 0,
      abandoned: 0,
      embedded: 0, // not consulted for a text space; nothing can be missing
      embedderConfigured: !!getImageEmbedder(),
      backfillInFlight: false,
      ready: true,
      blocker: null
    };
  }

  // One snapshot, not separate counts: the backfill increments the column these
  // are partitioned on, so independent reads can miss a crop crossing the cap
  // between them and report full coverage for a corpus that has none.
  const [{ retriable, abandoned, embedded }, backfillInFlight] = await Promise.all([
    imageVecCoverage(),
    hasInFlightJobOfType('characters.backfill-visuals')
  ]);
  const embedderConfigured = !!getImageEmbedder();

  if (retriable === 0 && abandoned === 0) {
    return {
      space: tuning.space,
      needsVisual,
      retriable,
      abandoned,
      embedded,
      embedderConfigured,
      backfillInFlight,
      ready: true,
      blocker: null
    };
  }

  // Three blockers, three different actions -- and only one of them resolves on
  // its own. Saying "draining" when nothing is draining is the worst of the
  // three: it promises a completion that will never arrive and leaves the panel
  // polling for it.
  let blocker: string;
  if (!embedderConfigured) {
    blocker =
      `VOYAGE_API_KEY is not set, so none of the ${retriable + abandoned} crop(s) missing a ` +
      `visual vector can ever be embedded -- the cron and the admin backfill both refuse without ` +
      `it. Set the key, or move the identity space back to 'text'.`;
  } else if (abandoned > 0) {
    blocker =
      `${abandoned} crop(s) can no longer be embedded (gave up after ${MAX_IMAGE_EMBED_ATTEMPTS} ` +
      `attempts each)${retriable > 0 ? ` and ${retriable} more are still missing` : ''}. ` +
      `Clustering in '${tuning.space}' would drop them and prune their characters from the canon. ` +
      `Fix by force re-detecting the affected images (re-cuts the crops), releasing the attempt ` +
      `cap once the cause is fixed, or moving the identity space back to 'text'.`;
  } else if (backfillInFlight) {
    blocker =
      `${retriable} crop(s) still lack a visual vector; the backfill is draining them. ` +
      `Clustering resumes automatically once coverage is complete.`;
  } else {
    blocker =
      `${retriable} crop(s) still lack a visual vector and no backfill is queued -- the last one ` +
      `ended without a successor. Start one from this page; the six-hourly cron will also file ` +
      `one on its next tick.`;
  }

  return {
    space: tuning.space,
    needsVisual,
    retriable,
    abandoned,
    embedded,
    embedderConfigured,
    backfillInFlight,
    ready: false,
    blocker
  };
}
