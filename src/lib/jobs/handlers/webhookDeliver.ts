import type { Job } from '@/lib/db/schema';
import { getWebhookById, recordDelivery } from '@/lib/db/queries/webhooks';
import { signBody } from '@/lib/webhooks/sign';

const REQUEST_TIMEOUT_MS = 10_000;
const BODY_PREVIEW_LIMIT = 2048;

type Payload = {
  webhookId: number;
  event: string;
  body: unknown;
  attempt: number;
};

function truncate(s: string): string {
  return s.length <= BODY_PREVIEW_LIMIT ? s : s.slice(0, BODY_PREVIEW_LIMIT);
}

export async function webhookDeliverHandler(job: Job): Promise<void> {
  const payload = job.payload as Payload;
  const webhook = await getWebhookById(payload.webhookId);
  // If the subscription has been deleted since enqueue, swallow silently --
  // not an error and we don't want it to keep retrying.
  if (!webhook || !webhook.active) return;

  const raw = JSON.stringify(payload.body);
  const signature = signBody(webhook.secret, raw);
  const deliveryId = crypto.randomUUID();
  const attempt = job.attempts + 1;

  let res: Response;
  try {
    res = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pix-Event': payload.event,
        'X-Pix-Signature': signature,
        'X-Pix-Delivery': deliveryId,
        'X-Pix-Attempt': String(attempt)
      },
      body: raw,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordDelivery({
      webhookId: webhook.id,
      event: payload.event,
      payload: payload.body,
      attempt,
      status: 'failed',
      error: msg
    });
    throw new Error(`delivery network error: ${msg}`);
  }

  const text = truncate(await res.text().catch(() => ''));
  const ok = res.status >= 200 && res.status < 300;
  await recordDelivery({
    webhookId: webhook.id,
    event: payload.event,
    payload: payload.body,
    attempt,
    status: ok ? 'success' : 'failed',
    responseStatus: res.status,
    responseBody: text || null
  });
  if (!ok) throw new Error(`delivery responded ${res.status}`);
}
