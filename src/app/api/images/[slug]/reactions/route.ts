import { NextResponse } from 'next/server';
import { getImageBySlug } from '@/lib/db/queries/images';
import { toggleReaction, countReactions } from '@/lib/db/queries/reactions';
import { hashIp, getRequestIp } from '@/lib/hash';
import { rateLimit } from '@/lib/rate-limit';

export async function GET(_req: Request, ctx: { params: { slug: string } }) {
  const img = await getImageBySlug(decodeURIComponent(ctx.params.slug));
  if (!img) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const counts = await countReactions(img.id);
  return NextResponse.json(counts);
}

export async function POST(req: Request, ctx: { params: { slug: string } }) {
  const ip = getRequestIp(req);
  const ipHash = hashIp(ip);

  // 10 reaction changes per IP per minute
  if (!rateLimit(`react:${ipHash}`, 10, 60_000)) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 });
  }

  const img = await getImageBySlug(decodeURIComponent(ctx.params.slug));
  if (!img) return NextResponse.json({ error: 'not found' }, { status: 404 });

  let kind: 'up' | 'down';
  let fingerprint: string | null = null;
  try {
    const body = await req.json();
    if (body.kind !== 'up' && body.kind !== 'down') {
      return NextResponse.json({ error: 'kind must be "up" or "down"' }, { status: 400 });
    }
    kind = body.kind;
    fingerprint = typeof body.fingerprint === 'string' ? body.fingerprint.slice(0, 64) : null;
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  const result = await toggleReaction(img.id, kind, ipHash, fingerprint);
  return NextResponse.json(result);
}
