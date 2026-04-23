import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../client';
import { webhookDeliveries, webhooks } from '../schema';
import type { Webhook, WebhookDelivery } from '../schema';

export async function listWebhooks(): Promise<Webhook[]> {
  return db.select().from(webhooks).orderBy(desc(webhooks.createdAt));
}

export async function getWebhook(id: number): Promise<Webhook | null> {
  const [row] = await db.select().from(webhooks).where(eq(webhooks.id, id)).limit(1);
  return row ?? null;
}

export async function createWebhook(input: {
  url: string;
  secret: string;
  events: string[];
}): Promise<Webhook> {
  const [row] = await db
    .insert(webhooks)
    .values({ url: input.url, secret: input.secret, events: input.events })
    .returning();
  if (!row) throw new Error('createWebhook returned no row');
  return row;
}

export async function updateWebhook(
  id: number,
  patch: Partial<{ url: string; events: string[]; active: boolean }>
): Promise<Webhook | null> {
  if (Object.keys(patch).length === 0) return getWebhook(id);
  const [row] = await db.update(webhooks).set(patch).where(eq(webhooks.id, id)).returning();
  return row ?? null;
}

export async function deleteWebhook(id: number): Promise<void> {
  await db.delete(webhooks).where(eq(webhooks.id, id));
}

// Find every active webhook subscribed to `event`. Used by the emitter to
// decide how many delivery jobs to enqueue.
export async function subscribedTo(event: string): Promise<Webhook[]> {
  return db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.active, true), sql`${event} = ANY(${webhooks.events})`));
}

export async function recordDelivery(input: {
  webhookId: number;
  event: string;
  payload: unknown;
  attempt: number;
  status: 'pending' | 'success' | 'failed';
  responseStatus?: number | null;
  responseBody?: string | null;
  error?: string | null;
}): Promise<WebhookDelivery> {
  const [row] = await db
    .insert(webhookDeliveries)
    .values({
      webhookId: input.webhookId,
      event: input.event,
      payload: input.payload as WebhookDelivery['payload'],
      attempt: input.attempt,
      status: input.status,
      responseStatus: input.responseStatus ?? null,
      responseBody: input.responseBody ?? null,
      error: input.error ?? null
    })
    .returning();
  if (!row) throw new Error('recordDelivery returned no row');
  return row;
}

export async function listDeliveries(webhookId: number, limit = 100): Promise<WebhookDelivery[]> {
  return db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.webhookId, webhookId))
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit);
}
