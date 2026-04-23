import { randomUUID } from 'node:crypto';
import { enqueueJob } from '@/lib/db/queries/jobs';
import { subscribedTo } from '@/lib/db/queries/webhooks';
import { API_VERSION, type WebhookEvent } from './schemas';

// Enqueue one webhook.deliver job per active subscriber. Never fires HTTP
// inline -- the cron drains the queue, so a slow consumer can't stall upload
// or comment routes. Callers must invoke AFTER their DB commit so the payload
// references persisted rows.
export async function emit(event: WebhookEvent, data: Record<string, unknown>): Promise<void> {
  let subs;
  try {
    subs = await subscribedTo(event);
  } catch (err) {
    // Emission failures are always best-effort. We don't want a webhooks
    // lookup hiccup to fail the upload/comment request that triggered it.
    console.error('webhook subscribedTo lookup failed', event, err);
    return;
  }
  if (subs.length === 0) return;

  const body = {
    event,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    apiVersion: API_VERSION,
    ...data
  };

  await Promise.all(
    subs.map((s) =>
      enqueueJob({
        type: 'webhook.deliver',
        payload: { webhookId: s.id, event, body, attempt: 1 }
      }).catch((err) => {
        console.error('failed to enqueue webhook delivery', s.id, event, err);
      })
    )
  );
}
