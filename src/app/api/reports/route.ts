import { NextResponse } from 'next/server';
import { addReport } from '@/lib/db/queries/reports';
import { hashIp, getRequestIp } from '@/lib/hash';
import { rateLimit } from '@/lib/rate-limit';

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

  await addReport(targetType, targetId, reason, ipHash);
  return NextResponse.json({ ok: true }, { status: 201 });
}
