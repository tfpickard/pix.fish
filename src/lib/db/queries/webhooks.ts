import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../client';
import { webhookDeliveries, webhooks } from '../schema';
import type { Webhook, WebhookDelivery } from '../schema';

export async function listWebhooks(ownerId: string): Promise<Webhook[]> {
  return db
    .select()
    .from(webhooks)
    .where(eq(webhooks.ownerId, ownerId))
    .orderBy(desc(webhooks.createdAt));
}

export async function getWebhook(ownerId: string, id: number): Promise<Webhook | null> {
  const [row] = await db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.ownerId, ownerId), eq(webhooks.id, id)))
    .limit(1);
  return row ?? null;
}

// Internal lookup by primary key without owner scoping. Used by the job
// runner (`webhookDeliverHandler`) which has no session and trusts the
// enqueued webhookId. HTTP-facing reads must use `getWebhook(ownerId, id)`
// to prevent cross-user access.
export async function getWebhookById(id: number): Promise<Webhook | null> {
  const [row] = await db.select().from(webhooks).where(eq(webhooks.id, id)).limit(1);
  return row ?? null;
}

export async function createWebhook(input: {
  ownerId: string;
  url: string;
  secret: string;
  events: string[];
}): Promise<Webhook> {
  const [row] = await db
    .insert(webhooks)
    .values({
      ownerId: input.ownerId,
      url: input.url,
      secret: input.secret,
      events: input.events
    })
    .returning();
  if (!row) throw new Error('createWebhook returned no row');
  return row;
}

export async function updateWebhook(
  ownerId: string,
  id: number,
  patch: Partial<{ url: string; events: string[]; active: boolean }>
): Promise<Webhook | null> {
  if (Object.keys(patch).length === 0) return getWebhook(ownerId, id);
  const [row] = await db
    .update(webhooks)
    .set(patch)
    .where(and(eq(webhooks.ownerId, ownerId), eq(webhooks.id, id)))
    .returning();
  return row ?? null;
}

export async function deleteWebhook(ownerId: string, id: number): Promise<void> {
  await db.delete(webhooks).where(and(eq(webhooks.ownerId, ownerId), eq(webhooks.id, id)));
}

// Find every active webhook subscribed to `event`. Used by the emitter to
// decide how many delivery jobs to enqueue. Cross-user: an event on user
// A's image fans out to A's webhooks (filtered by emitter), platform
// webhooks owned by site admins, etc. The owner filter happens at emit
// time, not here.
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
