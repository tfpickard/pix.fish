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
  // every crop missing its vec_image and abort. Drain the backfill inline first.
  if (knobs.space === 'visual' || knobs.space === 'blend') {
    const embedder = getImageEmbedder();
    if (!embedder) {
      console.error(
        `\naborting: --space=${knobs.space} needs visual vectors, but no VOYAGE_API_KEY is set.`
      );
      process.exit(1);
    }
    console.log(`ensuring visual vectors exist for --space=${knobs.space}...`);
    const { ok, fail } = await backfillVisualsInline(embedder, (m) => console.log(m));
    console.log(`  visual backfill: ${ok} embedded, ${fail} failed`);
    if (fail > 0 && !knobs.partialOk) {
      console.error(
        `\naborting before clustering: ${fail} crop(s) still lack a visual vector. Re-run to retry, or pass --partial-ok to cluster on the embedded subset.`
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
