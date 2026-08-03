import { ImageEmbedError, getImageEmbedder } from '@/lib/ai/imageEmbed';
import {
  abandonedImageVecSample,
  cropsMissingImageVec,
  imageVecCoverage,
  recordCropImageVecFailure,
  setCropImageVec,
  MAX_IMAGE_EMBED_ATTEMPTS
} from '@/lib/db/queries/character-crops';
import { earlierClaimedJobOfType, enqueueJob, mergeJobPayload } from '@/lib/db/queries/jobs';
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
// How many times a run will step aside for a sibling before running anyway.
// Bounded because deferring forever would be its own outage: a wedged sibling
// (or a reclaim race) must not be able to stop the drain permanently. Paying
// for a few duplicate embeddings is strictly better than never embedding.
const MAX_DEFERRALS = 3;
// Long enough that the sibling's 25s budget plus a trailing call has elapsed,
// so the retry usually finds the corpus clear on its first look.
const DEFER_MS = 45_000;

// `wrote` is carried across the whole continuation chain, not derived per run:
// the run that DRAINS the corpus is usually the one that embedded nothing (the
// work happened in its predecessors), so a per-run check would suppress exactly
// the recluster the chain exists to trigger. Sticky-true from the first vector
// written until the chain ends.
type Payload = { afterId?: number; sweep?: number; deferrals?: number; wrote?: boolean };

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
  // outlive its tick.
  //
  // The check is asymmetric on purpose (whoever started first wins, see
  // earlierClaimedJobOfType). A symmetric "is anyone else running?" would have
  // both racers defer, retry together, and collide once they exhaust their
  // deferrals -- a livelock ending in the exact double-spend it was meant to
  // stop. Ordering on claim time elects one winner outright, and on claim time
  // rather than on the id because claimJobs orders by run_at: a delayed low-id
  // retry can start while a high-id sweep is already running, and an id
  // ordering would let it see no elder and proceed alongside.
  //
  // The loser steps aside and retries rather than dropping: the enqueue that
  // triggered it may be the only thing covering crops the winner read too early
  // to see.
  const deferrals = Number(payload.deferrals ?? 0);
  if (deferrals < MAX_DEFERRALS && (await earlierClaimedJobOfType(job.type, job.id))) {
    console.log(
      `characters.backfill-visuals: an earlier sweep is running; deferring (${deferrals + 1}/${MAX_DEFERRALS})`
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
  const inheritedWrote = payload.wrote === true;
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
        // Stamp the change marker into THIS job's payload the moment the first
        // vector lands, rather than only passing it to a continuation. Everything
        // after this loop can fail -- the coverage read, the enqueue -- and a
        // retry re-reads the row as enqueued, so a run that embedded crops and
        // then died in its tail would come back with wrote=false, take the
        // no-change path, and leave the repaired corpus with a stale roster until
        // the next six-hourly cron. Once per run, only on the first write.
        if (ok === 1 && !inheritedWrote) await mergeJobPayload(job.id, { wrote: true });
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
  // Sticky across the chain: this run's vectors OR any earlier run's.
  const wrote = inheritedWrote || ok > 0;
  console.log(
    `characters.backfill-visuals: sweep ${sweep} embedded ${ok}, failed ${failed} of ${attempted} attempted (cursor ${afterId})`
  );

  if (budgetHit) {
    // Out of budget with more of this sweep ahead -- continue from the cursor,
    // same sweep number.
    await enqueueJob({
      type: 'characters.backfill-visuals',
      payload: { afterId, sweep, wrote },
      maxAttempts: 3
    });
    return;
  }

  // Full sweep finished. Anything still NULL and still under the per-crop
  // attempt cap failed somewhere in this pass and is worth another sweep;
  // anything over the cap is abandoned and no longer counted here. One snapshot
  // for both halves -- the sweep decision and the report below read the same
  // partition, and taking them as separate counts lets a crop crossing the cap
  // in between fall out of both.
  const { retriable: remaining, abandoned } = await imageVecCoverage();
  if (remaining > 0) {
    // Restart a FRESH sweep from the front (afterId 0), not from this job's end
    // cursor. Retrying this job's payload would only re-scan ids past the cursor
    // and never revisit an earlier crop that failed transiently, so a straggler
    // before the cursor would wedge visual/blend clustering despite the one-click
    // backfill. A clean restart re-attempts every still-NULL crop; embedded ones
    // are already skipped (vec_image not NULL), so only stragglers get re-tried.
    //
    // The condition is "anything left to try", NOT a chain-wide sweep budget.
    // A sweep counter is the wrong shape once spending is capped per crop: a
    // crop inserted by a detection that arrives late in the chain -- which
    // deliberately does NOT enqueue its own backfill, because a pending one
    // covers it -- would inherit a nearly-exhausted budget, get one attempt, and
    // then be stranded with no pending job at all until the six-hourly cron.
    // Termination is still guaranteed, and now by the thing that actually bounds
    // spend: each completed sweep either embeds a crop or spends one of its
    // three attempts, after which it stops being retriable. (A systemic failure
    // spends nothing, but it throws rather than reaching here.) `sweep` survives
    // as a diagnostic in the logs.
    const nextSweep = sweep + 1;
    console.log(
      `characters.backfill-visuals: ${remaining} crop(s) still missing after sweep ${sweep}; restarting sweep ${nextSweep}`
    );
    await enqueueJob({
      type: 'characters.backfill-visuals',
      payload: { afterId: 0, sweep: nextSweep, wrote },
      maxAttempts: 3
    });
    return;
  }

  // Nothing retriable is left. Report whatever the per-crop cap gave up on --
  // but do NOT throw. An abandoned crop is a STATE, not a job fault: re-running
  // this job cannot embed it, so failing here would only manufacture a red job
  // on every pass while fixing nothing. The blocker surfaces through the
  // coverage report instead (/api/cron/characters and the admin panel), where it
  // names an action a human can actually take.
  if (abandoned > 0) {
    const sample = await abandonedImageVecSample(5);
    console.warn(
      `characters.backfill-visuals: giving up on ${abandoned} crop(s) after ${MAX_IMAGE_EMBED_ATTEMPTS} ` +
        `attempts each. Sample: ` +
        sample.map((c) => `crop ${c.cropId} (image ${c.imageId}) ${c.blobUrl}`).join('; ')
    );
    // Deliberately NOT returning here. Abandoned crops block a visual/blend
    // cluster, but they are irrelevant to 'text' (or a zero-weight blend) -- and
    // switching the space is one of the remedies this very message recommends.
    // scheduleRecluster re-reads the saved tuning and defers on its own when the
    // space still needs those vectors, so letting it decide is both correct and
    // the only way an admin who took the advice gets a roster refresh before the
    // next six-hourly cron.
  }

  // Recluster only if this chain actually wrote a vector: a backfill fired
  // against an already-complete corpus (a second admin click, a stale duplicate)
  // changed nothing, and scheduleRecluster deliberately ignores a
  // currently-processing cluster, so a no-op run would fan out a redundant
  // corpus-wide verify + census -- paid LLM work for a crop set nobody touched.
  // When it did write, close the loop here rather than making the roster wait
  // for the next 6-hourly cron tick.
  if (!wrote) return;
  await scheduleRecluster();
}
