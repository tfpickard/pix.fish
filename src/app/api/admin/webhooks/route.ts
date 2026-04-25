import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth, isOwner } from '@/lib/auth';
import { createWebhook, listWebhooks } from '@/lib/db/queries/webhooks';
import { getSiteAdminId } from '@/lib/db/queries/users';
import { newWebhookSecret } from '@/lib/webhooks/sign';
import { WEBHOOK_EVENTS } from '@/lib/webhooks/schemas';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const createSchema = z.object({
  url: z.string().url(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1)
});

export async function GET() {
  if (!isOwner(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const rows = await listWebhooks(getSiteAdminId());
  // Redact secrets in list views; the owner saw it once at creation.
  return NextResponse.json({
    webhooks: rows.map((w) => ({ ...w, secret: undefined }))
  });
}

export async function POST(req: Request) {
  if (!isOwner(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', issues: parsed.error.issues }, { status: 400 });
  }
  const secret = newWebhookSecret();
  const row = await createWebhook({
    ownerId: getSiteAdminId(),
    url: parsed.data.url,
    secret,
    events: parsed.data.events
  });
  // Secret is returned in full here and only here; subsequent GETs redact.
  return NextResponse.json({ webhook: row }, { status: 201 });
}
