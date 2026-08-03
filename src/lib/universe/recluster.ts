import { nextClusterRunStamp } from '@/lib/db/queries/events';
import { enqueueJob, hasPendingJobOfType } from '@/lib/db/queries/jobs';
import { clusterReadiness } from '@/lib/universe/visual-coverage';

// Debounce window for the roster recluster fired after a detection. Long enough
// that a burst of detections (an upload flurry, or a detect-all) collapses to
// ~one cluster run via the pending-dedupe, short enough that a single new upload
// surfaces on the characters page within a couple of minutes.
export const RECLUSTER_DEBOUNCE_MS = 120_000;

// Refresh the recurring-subjects roster after the crop set changes. Clustering
// is corpus-wide and expensive (all-pairs + an LLM verify per candidate + a
// census), so enqueue a single characters.cluster on a short delay, deduped
// against any already-PENDING one -- pending, not processing: a processing
// cluster may already have read the crop set and so can't be relied on to cover
// crops this change touched. A burst of detections collapses to ~one run. The
// runStamp is stamped at enqueue so a reclaim reuses it and collapses through
// the census dedupe key (matching /api/admin/characters/cluster); knobs resolve
// from the saved tuning.
//
// Skips entirely when the saved identity space needs visual vectors the crops
// don't have yet: that run would abort in produceCandidates, so filing it only
// costs a red job. The backfill re-invokes this once it drains, and the
// 6-hourly cron re-checks in the meantime, so nothing is lost by waiting.
//
// Best-effort: the crop changes are already committed, so a failed enqueue must
// not fail the caller.
export async function scheduleRecluster(): Promise<void> {
  try {
    const readiness = await clusterReadiness();
    if (!readiness.ready) {
      console.log(`characters: recluster deferred -- ${readiness.blocker}`);
      return;
    }
    if (await hasPendingJobOfType('characters.cluster')) return;
    await enqueueJob({
      type: 'characters.cluster',
      payload: { runStamp: await nextClusterRunStamp() },
      runAt: new Date(Date.now() + RECLUSTER_DEBOUNCE_MS),
      maxAttempts: 1
    });
  } catch (err) {
    console.error('characters: failed to enqueue characters.cluster', err);
  }
}
