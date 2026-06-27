import { listAllImageEdges } from '@/lib/db/queries/knn';
import { enqueueJob } from '@/lib/db/queries/jobs';
import { listSalienceInputs } from '@/lib/db/queries/specimens';
import type { Job } from '@/lib/db/schema';
import { selectSalientSpecimens } from '@/lib/universe/salience';

type Payload = { count?: number; seed?: number };

const DEFAULT_COUNT = 3;
const MAX_COUNT = 8;

// The recurring driver of the evolution loop. Scores every specimen for
// salience and enqueues a bounded number of universe.amend jobs for the most
// deserving. Does no generation itself -- that is the amend handler's job, so a
// single tick never blows the cron wall budget.
export async function universeTickHandler(job: Job): Promise<void> {
  const payload = (job.payload ?? {}) as Payload;
  const count = Math.min(Math.max(Math.trunc(payload.count ?? DEFAULT_COUNT), 1), MAX_COUNT);
  // A seed makes the tick reproducible from its log; default to wall-clock so
  // successive ticks roam different specimens.
  const seed = payload.seed ?? Math.floor(Date.now() % 2_147_483_647);

  const [specimens, edges] = await Promise.all([listSalienceInputs(), listAllImageEdges()]);
  if (specimens.length === 0) return;

  const picks = selectSalientSpecimens(specimens, {
    count,
    seed,
    nowMs: Date.now(),
    edges
  });

  for (const pick of picks) {
    // Vary the per-amend seed so each picked specimen's clerk choice differs.
    await enqueueJob({
      type: 'universe.amend',
      payload: { imageId: pick.imageId, seed: seed + pick.imageId, depth: 0 },
      maxAttempts: 3
    });
  }

  console.log(
    `universe.tick: enqueued ${picks.length} amendment(s):`,
    picks.map((p) => `${p.imageId}[${p.reasons.join(',')}]`).join(' ')
  );
}
