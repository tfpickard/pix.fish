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
import { listDetectableImageIds } from '../src/lib/db/queries/images';
import type { Job } from '../src/lib/db/schema';
import { charactersClusterHandler } from '../src/lib/jobs/handlers/charactersCluster';
import { charactersDetectHandler } from '../src/lib/jobs/handlers/charactersDetect';

function asJob(payload: Record<string, unknown>): Job {
  return { payload } as unknown as Job;
}

async function main() {
  const force = process.argv.includes('--force');
  const clusterOnly = process.argv.includes('--cluster-only');
  const allowPartial = process.argv.includes('--allow-partial');

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

  console.log('clustering crops into recurring characters...');
  // No stamp -- let the handler mint a unique per-run census stamp so repeated
  // runs file distinct events instead of colliding on the same dedupe key.
  await charactersClusterHandler(asJob({ minAppearances: 2 }));
  console.log('done.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit(0));
