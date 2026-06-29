/**
 * Offline character pipeline: detect + crop figures across every eligible
 * image, then cluster the crops into recurring characters and file the census.
 *
 * Runs the job handlers directly (no cron needed) so you can populate the
 * character canon in one shot, e.g. after the Phase 1 bootstrap. Detection is
 * idempotent per image (skips images that already have crops unless --force);
 * clustering files a new census each run (newest wins).
 *
 *   bun scripts/characters-detect.ts            # detect new + cluster
 *   bun scripts/characters-detect.ts --force    # re-detect all + cluster
 *   bun scripts/characters-detect.ts --cluster-only
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
