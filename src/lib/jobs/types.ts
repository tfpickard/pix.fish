import type { ProviderField } from '@/lib/ai';

// Union keeps the dispatcher + handler map exhaustive: adding a new `type`
// value forces a corresponding handler and payload schema.
export type JobType = 'noop' | 'reprocess.image' | 'umap.recompute' | 'backup.export' | 'webhook.deliver';

export type JobPayload =
  | { type: 'noop'; data: {} }
  | { type: 'reprocess.image'; data: { imageId: number; fields: ProviderField[] } }
  | { type: 'umap.recompute'; data: { nNeighbors: number; minDist: number; kind: string } }
  | { type: 'backup.export'; data: { requestedBy: string } }
  | { type: 'webhook.deliver'; data: { webhookId: number; event: string; body: unknown; attempt: number } };

export type JobStatus = 'pending' | 'processing' | 'done' | 'failed';
