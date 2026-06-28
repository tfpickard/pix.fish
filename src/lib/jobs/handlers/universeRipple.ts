import { getNeighborsByImageId } from '@/lib/db/queries/embeddings';
import { enqueueJob } from '@/lib/db/queries/jobs';
import type { Job } from '@/lib/db/schema';

type Payload = { imageId: number; seed?: number; depth?: number };

const MAX_DEPTH = 1; // one hop only -- ripples never cascade beyond direct neighbours
const RIPPLE_FANOUT = 2; // amend at most this many nearest neighbours

// Event-driven ripple: when a specimen is amended, nudge its nearest
// neighbours so a new reading propagates through the manifold. Strictly
// bounded -- a single hop, a small fan-out, and the resulting amends are filed
// at depth+1 so they never ripple again. This is the contained version of the
// Phase 2 "ripples to neighbours" behaviour.
export async function universeRippleHandler(job: Job): Promise<void> {
  const { imageId, seed = imageId, depth = 0 } = job.payload as Payload;
  if (depth >= MAX_DEPTH) return;

  const near = await getNeighborsByImageId(imageId, {
    limit: RIPPLE_FANOUT,
    kind: 'caption',
    order: 'nearest'
  }).catch(() => []);

  for (const n of near) {
    await enqueueJob({
      type: 'universe.amend',
      payload: { imageId: n.imageId, seed: seed + n.imageId, depth: depth + 1 },
      maxAttempts: 3
    });
  }
}
