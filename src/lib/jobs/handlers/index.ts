import type { Job } from '@/lib/db/schema';
import { webhookDeliverHandler } from './webhookDeliver';
import { reprocessImageHandler } from './reprocessImage';
import { umapRecomputeHandler } from './umapRecompute';
import { backupExportHandler } from './backupExport';

// Handlers are registered here; each sub-phase of Phase 4 adds its own.
// Missing handlers cause the worker to mark the job failed immediately, so
// orphaned job types don't silently loop.
export type JobHandler = (job: Job) => Promise<void>;

export const handlers: Record<string, JobHandler> = {
  noop: async () => {
    // No-op used for queue smoke tests.
  },
  'webhook.deliver': webhookDeliverHandler,
  'reprocess.image': reprocessImageHandler,
  'umap.recompute': umapRecomputeHandler,
  'backup.export': backupExportHandler
};
