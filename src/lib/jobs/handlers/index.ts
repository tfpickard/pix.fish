import type { Job } from '@/lib/db/schema';
import type { JobContext } from '../worker';
import { webhookDeliverHandler } from './webhookDeliver';
import { reprocessImageHandler } from './reprocessImage';
import { enrichImageHandler } from './enrichImage';
import { deriveImageHandler } from './deriveImage';
import { umapRecomputeHandler } from './umapRecompute';
import { backupExportHandler } from './backupExport';
import { entropyRecomputeHandler } from './entropyRecompute';
import { nsfwScanHandler } from './nsfwScan';
import { knnRebuildHandler } from './knnRebuild';
import { manifoldRecomputeHandler } from './manifoldRecompute';
import { universeTickHandler } from './universeTick';
import { universeAmendHandler } from './universeAmend';
import { universeRippleHandler } from './universeRipple';
import { charactersDetectHandler } from './charactersDetect';
import { charactersClusterHandler } from './charactersCluster';
import { charactersVerifyHandler } from './charactersVerify';
import { charactersCensusHandler } from './charactersCensus';
import { charactersBackfillVisualsHandler } from './charactersBackfillVisuals';
import { desirePromoteHandler } from './desirePromote';
import { xDispatchHandler } from './xDispatch';

// Handlers are registered here; each sub-phase of Phase 4 adds its own.
// Missing handlers cause the worker to mark the job failed immediately, so
// orphaned job types don't silently loop.
//
// Gate-0 contract: reserved job-type keys for the parallel-build features.
// Each feature worktree registers its own handler here at its gate; the keys
// are fixed now so enqueue sites and handlers agree. Do NOT enqueue these
// before the handler is registered (the worker would fail the job):
//   'nsfw.scan'         -- feat/hud: per-image Haiku nudity classification
//   'entropy.recompute' -- feat/hud: surprisal + collection temperature
//   'manifold.recompute'-- feat/manifold: 3D umap projection
//   'knn.rebuild'       -- feat/geodesics: kNN graph rebuild
// (feat/stigmergy and feat/alive run inline/admin-triggered, no new job type.)
// `ctx` is optional at the handler's end so the many handlers with no
// irreversible side effect can keep ignoring it. Handlers that DO publish
// something have to consult it: the drain runs several jobs inside one function
// invocation, so a handler's own start time is not the deadline that matters.
export type JobHandler = (job: Job, ctx: JobContext) => Promise<void>;

export const handlers: Record<string, JobHandler> = {
  noop: async () => {
    // No-op used for queue smoke tests.
  },
  'webhook.deliver': webhookDeliverHandler,
  'reprocess.image': reprocessImageHandler,
  'enrich.image': enrichImageHandler,
  // Generate WebP derivatives for a newly enriched image (enqueued by
  // enrich.image) so new uploads get small tiles without a manual backfill.
  'derive.image': deriveImageHandler,
  'umap.recompute': umapRecomputeHandler,
  'backup.export': backupExportHandler,
  'entropy.recompute': entropyRecomputeHandler,
  'nsfw.scan': nsfwScanHandler,
  // feat/geodesics: build kNN graph over caption embeddings -> knn_edges
  'knn.rebuild': knnRebuildHandler,
  'manifold.recompute': manifoldRecomputeHandler,
  // Universe (Phase U2) evolution loop: tick selects salient specimens and
  // enqueues amendments; amend generates one clerk amendment; ripple nudges a
  // bounded set of neighbours.
  'universe.tick': universeTickHandler,
  'universe.amend': universeAmendHandler,
  'universe.ripple': universeRippleHandler,
  // Universe (Phase U3): detect + crop figures per image; cluster crops into
  // recurring characters and file the census. Clustering is a 3-stage pipeline:
  // cluster (candidates) -> verify (per-candidate mosaic split) -> census
  // (barrier + assemble + dossiers).
  'characters.detect': charactersDetectHandler,
  'characters.cluster': charactersClusterHandler,
  'characters.verify': charactersVerifyHandler,
  'characters.census': charactersCensusHandler,
  // Backfill visual (Voyage multimodal) vectors for crops that lack one; drains
  // in batches over successive ticks.
  'characters.backfill-visuals': charactersBackfillVisualsHandler,
  // Desire paths: assemble worn path_traffic edges into corridors and promote
  // the ones above a strength floor into desire_paths (retiring decayed ones).
  'desire.promote': desirePromoteHandler,
  // Outbound X dispatch: one trend fetch, one safety classification, one
  // specimen pick, one caption. Enqueued once a day by /api/cron/dispatch with
  // maxAttempts 1; the day-claim event makes a second run impossible.
  'x.dispatch': xDispatchHandler
};
