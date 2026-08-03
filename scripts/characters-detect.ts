/**
 * Offline character pipeline: detect + crop figures across every eligible
 * image, then cluster the crops into recurring characters and file the census.
 *
 * Runs the job handlers directly (no cron needed) so you can populate the
 * character canon in one shot, e.g. after the Phase 1 bootstrap. Detection is
 * idempotent per image (skips images that already have crops unless --force);
 * clustering files a new census each run (newest wins).
 *
 *   bun scripts/characters-detect.ts                 # detect new + cluster
 *   bun scripts/characters-detect.ts --force         # re-detect all + cluster
 *   bun scripts/characters-detect.ts --cluster-only
 *   bun scripts/characters-detect.ts --allow-partial # cluster even if some detects failed
 */
import { getImageEmbedder } from '../src/lib/ai/imageEmbed';
import {
  countCropsAbandonedImageVec,
  countCropsMissingImageVec,
  MAX_IMAGE_EMBED_ATTEMPTS
} from '../src/lib/db/queries/character-crops';
import { listDetectableImageIds } from '../src/lib/db/queries/images';
import type { Job } from '../src/lib/db/schema';
import {
  produceCandidates,
  resolveKnobs
} from '../src/lib/jobs/handlers/charactersCluster';
import { verifyCandidate } from '../src/lib/jobs/handlers/charactersVerify';
import { assembleCensus } from '../src/lib/jobs/handlers/charactersCensus';
import { charactersDetectHandler } from '../src/lib/jobs/handlers/charactersDetect';
import { backfillVisualsInline } from '../src/lib/universe/backfill-visuals';

function asJob(payload: Record<string, unknown>): Job {
  return { payload } as unknown as Job;
}

// Parse "--flag=value" knob overrides so a sweep can run e.g.
//   bun run characters:detect --cluster-only --maxDist=0.32 --space=visual --no-verify
function numArg(name: string): number | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : undefined;
}
function strArg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : undefined;
}

// Whether the chosen clustering space actually reads the visual vec, matching
// cropClusterVector's degenerate-weight handling: 'visual' always does; 'blend'
// only when weight > 0 (weight 0 collapses to pure text); 'text' never does.
function needsVisualVec(space: string, blendWeight: number): boolean {
  if (space === 'visual') return true;
  if (space === 'blend') return blendWeight > 0;
  return false;
}

async function main() {
  const force = process.argv.includes('--force');
  const clusterOnly = process.argv.includes('--cluster-only');
  const allowPartial = process.argv.includes('--allow-partial');
  const noVerify = process.argv.includes('--no-verify');

  if (!clusterOnly) {
    const ids = await listDetectableImageIds();
    console.log(`detecting figures across ${ids.length} image(s)${force ? ' (force)' : ''}`);
    let ok = 0;
    let fail = 0;
    for (const imageId of ids) {
      try {
        await charactersDetectHandler(asJob({ imageId, force }));
        ok++;
        if (ok % 10 === 0) console.log(`  ${ok}/${ids.length}`);
      } catch (err) {
        fail++;
        console.error(`  [${imageId}] detect failed:`, err);
      }
    }
    console.log(`detect: ${ok} ok, ${fail} failed`);

    // The census is newest-wins, so clustering after a partial detect run would
    // replace the canon with a roster built from incomplete evidence. Abort
    // unless the operator explicitly opted into a partial census.
    if (fail > 0 && !allowPartial) {
      console.error(
        `\naborting before clustering: ${fail} detection(s) failed. Re-run to retry, or pass --allow-partial to cluster anyway.`
      );
      process.exit(1);
    }
  }

  // Run the full clustering pipeline INLINE (cluster -> verify -> census) rather
  // than enqueuing jobs, so a local sweep completes in one shot. Knob overrides
  // from the CLI fall back to the saved tuning.
  const spaceArg = strArg('space');
  const knobs = await resolveKnobs({
    maxDist: numArg('maxDist'),
    k: numArg('k'),
    pruneK: numArg('pruneK'),
    minAppearances: numArg('minAppearances'),
    verifyEnabled: noVerify ? false : undefined,
    space: spaceArg === 'visual' || spaceArg === 'blend' || spaceArg === 'text' ? spaceArg : undefined,
    blendWeight: numArg('blendWeight'),
    partialOk: process.argv.includes('--partial-ok') || undefined
  });
  // Detection only writes each crop's text vec; the visual vec is filled
  // out-of-band (the queue's backfill job online, or characters:backfill-visuals
  // offline). This script enqueues nothing, so a visual/blend cluster would find
  // crops missing their vec_image and abort. Backfill inline first -- but only
  // when the chosen space actually reads the visual vec AND some crop is missing
  // it. A cluster-only sweep over an already-populated corpus (or blend at
  // weight 0, which cropClusterVector treats as pure text) needs no Voyage call,
  // so don't require VOYAGE_API_KEY for those.
  if (needsVisualVec(knobs.space, knobs.blendWeight)) {
    // Count only what the backfill will still attempt. Crops past the per-crop
    // attempt cap are reported separately below -- a sweep that re-attempted
    // them would spend a paid call per crop to fail again.
    const missing = await countCropsMissingImageVec();
    if (missing > 0) {
      const embedder = getImageEmbedder();
      if (!embedder) {
        console.error(
          `\naborting: --space=${knobs.space} needs visual vectors for ${missing} crop(s), but no VOYAGE_API_KEY is set.`
        );
        process.exit(1);
      }
      console.log(`backfilling visual vectors for ${missing} crop(s)...`);
      const { ok, fail } = await backfillVisualsInline(embedder, (m) => console.log(m));
      console.log(`  visual backfill: ${ok} embedded, ${fail} failed`);
      // Base the abort on a FRESH missing count, not the cumulative fail tally:
      // a crop can fail one attempt and succeed on a later run, so `fail` may be
      // positive while the corpus is fully backfilled.
      const stillMissing = await countCropsMissingImageVec();
      if (stillMissing > 0 && !knobs.partialOk) {
        console.error(
          `\naborting before clustering: ${stillMissing} crop(s) still lack a visual vector. Re-run to retry, or pass --partial-ok to cluster on the embedded subset.`
        );
        process.exit(1);
      }
    }
    // Abandoned crops are invisible to the backfill (that is the point of the
    // cap), so check them explicitly -- otherwise a fully-drained retry queue
    // reads as success here and produceCandidates aborts a step later with no
    // mention of why those crops are unreachable.
    const abandoned = await countCropsAbandonedImageVec();
    if (abandoned > 0 && !knobs.partialOk) {
      console.error(
        `\naborting before clustering: ${abandoned} crop(s) failed to embed ${MAX_IMAGE_EMBED_ATTEMPTS} times and are no longer retried. ` +
          `Force re-detect the affected images to re-cut them, release the cap from /admin/characters once the cause is fixed, ` +
          `or pass --partial-ok to cluster without them (their characters get pruned from the canon).`
      );
      process.exit(1);
    }
  }

  console.log('clustering crops into recurring characters...');
  const count = await produceCandidates(knobs);
  if (knobs.verifyEnabled) {
    console.log(`verifying ${count} candidate(s) via the mosaic pass...`);
    for (let i = 0; i < count; i++) {
      try {
        await verifyCandidate(knobs.runStamp, i);
      } catch (err) {
        console.error(`  candidate ${i} verify failed (census will keep it whole):`, err);
      }
    }
  }
  await assembleCensus(knobs.runStamp, knobs.minAppearances);
  console.log('done.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit(0));
