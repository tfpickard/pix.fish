import { ImageEmbedError, getImageEmbedder } from '@/lib/ai/imageEmbed';
import {
  abandonedImageVecSample,
  cropsMissingImageVec,
  imageVecCoverage,
  recordCropImageVecFailure,
  setCropImageVec,
  MAX_IMAGE_EMBED_ATTEMPTS
} from '@/lib/db/queries/character-crops';
import { enqueueJob, otherProcessingJobOfType } from '@/lib/db/queries/jobs';
import type { Job } from '@/lib/db/schema';
import { scheduleRecluster } from '@/lib/universe/recluster';

// Admin-triggered visual-vector backfill. Embeds crops that lack a vec_image
// (Voyage multimodal) up to a wall-clock budget, then re-enqueues itself while
// more remain, so a large corpus drains across ticks without a local script.
// Runs server-side, where VOYAGE_API_KEY + blob access live. Idempotent: only
// touches crops still missing a visual vector.
const BATCH = 25;
// Stop embedding past this and re-enqueue, so a batch of slow Voyage calls can't
// blow the 45s worker budget before scheduling the next batch. Leaves headroom
// for one in-flight call (aborts at 15s) under the budget.
const BUDGET_MS = 25_000;
// How many full front-to-back sweeps to attempt before giving up. Each completed
// sweep that still leaves crops NULL restarts a fresh sweep from id 0 to re-embed
// stragglers (recovering transient failures anywhere in the corpus). Bounded so a
// genuinely-poisoned crop -- blob deleted, always fails -- eventually surfaces as
// a failed job instead of restarting forever.
const MAX_SWEEPS = 3;
// How many times a run will step aside for a sibling before running anyway.
// Bounded because deferring forever would be its own outage: a wedged sibling
// (or a reclaim race) must not be able to stop the drain permanently. Paying
// for a few duplicate embeddings is strictly better than never embedding.
const MAX_DEFERRALS = 3;
// Long enough that the sibling's 25s budget plus a trailing call has elapsed,
// so the retry usually finds the corpus clear on its first look.
const DEFER_MS = 45_000;

type Payload = { afterId?: number; sweep?: number; deferrals?: number };

export async function charactersBackfillVisualsHandler(job: Job): Promise<void> {
  const embedder = getImageEmbedder();
  if (!embedder) throw new Error('characters.backfill-visuals: no VOYAGE_API_KEY configured');

  const payload = (job.payload as Payload | undefined) ?? {};

  // Serialize corpus sweeps. cropsMissingImageVec is a predicate, not a claim,
  // so two concurrent runs select the same under-cap crops and pay Voyage twice
  // for each -- and, when they fail, charge the crop two attempts for one fault,
  // overshooting the cap this job promises. Concurrency is reachable in practice:
  // characters.detect deliberately enqueues even while one is processing, the
  // admin button has no dedupe, and a sweep that starts late in a drain can
  // outlive its tick. Step aside and retry rather than drop the run -- the
  // enqueue that triggered this may be the only thing covering crops the sibling
  // read too early to see.
  const deferrals = Number(payload.deferrals ?? 0);
  if (deferrals < MAX_DEFERRALS && (await otherProcessingJobOfType(job.type, job.id))) {
    console.log(
      `characters.backfill-visuals: another sweep is running; deferring (${deferrals + 1}/${MAX_DEFERRALS})`
    );
    await enqueueJob({
      type: 'characters.backfill-visuals',
      payload: { ...payload, deferrals: deferrals + 1 },
      runAt: new Date(Date.now() + DEFER_MS),
      maxAttempts: 3
    });
    return;
  }
  // Cursor-paged by crop id. `afterId` advances past every crop we ATTEMPT
  // (success OR failure), so a poisoned prefix -- crops whose blobs were deleted
  // and always fail -- can't wedge the drain: we step past it and reach the valid
  // crops behind it. `sweep` counts how many full front-to-back passes we've
  // already completed (budget continuations keep the same sweep number).
  let afterId = Number(payload.afterId ?? 0);
  const sweep = Number(payload.sweep ?? 0);
  const startedAt = Date.now();
  let ok = 0;
  let failed = 0;
  let attempted = 0;
  let budgetHit = false;

  outer: for (;;) {
    if (Date.now() - startedAt > BUDGET_MS) {
      budgetHit = true;
      break;
    }
    const crops = await cropsMissingImageVec(BATCH, afterId);
    if (crops.length === 0) break; // reached the end of this sweep
    for (const crop of crops) {
      if (Date.now() - startedAt > BUDGET_MS) {
        budgetHit = true;
        break outer;
      }
      attempted++;
      try {
        const vec = await embedder.embed(crop.blobUrl);
        await setCropImageVec(crop.cropId, vec, embedder.name, embedder.model);
        ok++;
      } catch (err) {
        // Spending an attempt requires POSITIVE evidence that this crop is the
        // problem: an ImageEmbedError the provider classified as crop-scoped.
        // Everything else -- a systemic embedder failure, a malformed 200 body,
        // a failed setCropImageVec write -- is either corpus-wide or about our
        // own infrastructure, and would charge healthy crops for it. Three of
        // those and the crop is abandoned, blocking visual clustering until a
        // human resets it. So abort the run and let the queue's backoff retry:
        // vectors are written as they are earned, so nothing already embedded
        // is lost.
        if (!(err instanceof ImageEmbedError) || err.systemic) {
          throw new Error(
            `characters.backfill-visuals: aborting after ${ok} embedded this run -- ` +
              `not a crop-specific failure: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        failed++;
        // Deliberately NOT swallowed. This write is the only thing that makes a
        // crop fault cost anything; if it silently no-ops, the crop stays under
        // the cap forever and every future sweep re-buys the same failing call.
        // A failed write is a persistence failure like any other here, so it
        // aborts the run for the queue to retry rather than advancing the cursor
        // past a crop whose attempt was never recorded.
        await recordCropImageVecFailure(crop.cropId);
        console.error(`characters.backfill-visuals: crop ${crop.cropId} failed`, err);
      }
      afterId = crop.cropId; // advance the cursor past this crop, success or fail
    }
  }
  console.log(
    `characters.backfill-visuals: sweep ${sweep} embedded ${ok}, failed ${failed} of ${attempted} attempted (cursor ${afterId})`
  );

  if (budgetHit) {
    // Out of budget with more of this sweep ahead -- continue from the cursor,
    // same sweep number.
    await enqueueJob({
      type: 'characters.backfill-visuals',
      payload: { afterId, sweep },
      maxAttempts: 3
    });
    return;
  }

  // Full sweep finished. Anything still NULL and still under the per-crop
  // attempt cap failed transiently somewhere in this pass and is worth another
  // sweep; anything over the cap is abandoned and no longer counted here.
  // One snapshot for both halves -- the sweep decision and the report below read
  // the same partition, and taking them as separate counts lets a crop crossing
  // the cap in between fall out of both.
  const { retriable: remaining, abandoned } = await imageVecCoverage();
  if (remaining > 0 && sweep + 1 < MAX_SWEEPS) {
    // Restart a FRESH sweep from the front (afterId 0), not from this job's end
    // cursor. Retrying this job's payload would only re-scan ids past the cursor
    // and never revisit an earlier crop that failed transiently, so a straggler
    // before the cursor would wedge visual/blend clustering despite the one-click
    // backfill. A clean restart re-attempts every still-NULL crop; embedded ones
    // are already skipped (vec_image not NULL), so only stragglers get re-tried.
    const nextSweep = sweep + 1;
    console.log(
      `characters.backfill-visuals: ${remaining} crop(s) still missing after sweep ${sweep}; restarting sweep ${nextSweep}`
    );
    await enqueueJob({
      type: 'characters.backfill-visuals',
      payload: { afterId: 0, sweep: nextSweep },
      maxAttempts: 3
    });
    return;
  }

  // Nothing retriable is left within this job's sweep budget. Report whatever
  // the per-crop cap gave up on -- but do NOT throw. An abandoned crop is a
  // STATE, not a job fault: re-running this job cannot embed it, so failing here
  // would only manufacture a red job on every pass while fixing nothing. The
  // blocker surfaces through the coverage report instead (/api/cron/characters
  // and the admin panel), where it names an action a human can actually take.
  if (abandoned > 0) {
    const sample = await abandonedImageVecSample(5);
    console.warn(
      `characters.backfill-visuals: giving up on ${abandoned} crop(s) after ${MAX_IMAGE_EMBED_ATTEMPTS} ` +
        `attempts each (${remaining} still retriable). Sample: ` +
        sample.map((c) => `crop ${c.cropId} (image ${c.imageId}) ${c.blobUrl}`).join('; ')
    );
    return;
  }
  if (remaining > 0) {
    console.warn(
      `characters.backfill-visuals: ${remaining} crop(s) still retriable after ${MAX_SWEEPS} sweeps`
    );
    return;
  }

  // Fully drained. The crops that were blocking a visual/blend cluster now have
  // their vectors, so close the loop here rather than making the roster wait for
  // the next 6-hourly cron tick.
  await scheduleRecluster();
}
