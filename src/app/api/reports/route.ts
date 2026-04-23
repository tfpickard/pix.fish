import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { images } from '@/lib/db/schema';
import { addReport } from '@/lib/db/queries/reports';
import { hashIp, getRequestIp } from '@/lib/hash';
import { rateLimit } from '@/lib/rate-limit';
import { emit } from '@/lib/webhooks/emit';

export async function POST(req: Request) {
  const ip = getRequestIp(req);
  const ipHash = hashIp(ip);

  // 5 reports per IP per hour
  if (!rateLimit(`report:${ipHash}`, 5, 60 * 60_000)) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 });
  }

  let targetType: string;
  let targetId: number;
  let reason: string | null = null;
  try {
    const body = await req.json();
    targetType = body.targetType;
    targetId = parseInt(body.targetId, 10);
    reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 500) : null;
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  if (targetType !== 'image' && targetType !== 'comment') {
    return NextResponse.json({ error: 'targetType must be "image" or "comment"' }, { status: 400 });
  }
  if (isNaN(targetId)) {
    return NextResponse.json({ error: 'invalid targetId' }, { status: 400 });
  }

  const report = await addReport(targetType, targetId, reason, ipHash);

  // image reports carry a slug in the payload; comment reports just the id.
  let imageSlug: string | null = null;
  if (targetType === 'image') {
    const [img] = await db
      .select({ slug: images.slug })
      .from(images)
      .where(eq(images.id, targetId))
      .limit(1);
    imageSlug = img?.slug ?? null;
  }

  await emit('report.created', {
    report: {
      id: report.id,
      targetType: report.targetType as 'image' | 'comment',
      imageSlug,
      commentId: report.commentId,
      reason: report.reason,
      createdAt: report.createdAt.toISOString()
    }
  });
  return NextResponse.json({ ok: true }, { status: 201 });
}
