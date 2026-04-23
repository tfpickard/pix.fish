import { NextResponse } from 'next/server';
import { getImageBySlug } from '@/lib/db/queries/images';
import { addComment, listApprovedComments } from '@/lib/db/queries/comments';
import { hashIp, getRequestIp } from '@/lib/hash';
import { rateLimit } from '@/lib/rate-limit';
import { emit } from '@/lib/webhooks/emit';

export async function GET(_req: Request, ctx: { params: { slug: string } }) {
  const img = await getImageBySlug(decodeURIComponent(ctx.params.slug));
  if (!img) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const rows = await listApprovedComments(img.id);
  return NextResponse.json(rows);
}

export async function POST(req: Request, ctx: { params: { slug: string } }) {
  const ip = getRequestIp(req);
  const ipHash = hashIp(ip);

  // 3 comments per IP per 10 minutes
  if (!rateLimit(`comment:${ipHash}`, 3, 10 * 60_000)) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 });
  }

  const img = await getImageBySlug(decodeURIComponent(ctx.params.slug));
  if (!img) return NextResponse.json({ error: 'not found' }, { status: 404 });

  let body: string;
  let authorName: string | null = null;
  let honeypot: string | undefined;
  try {
    const parsed = await req.json();
    body = typeof parsed.body === 'string' ? parsed.body.trim() : '';
    authorName = typeof parsed.authorName === 'string' ? parsed.authorName.trim().slice(0, 80) : null;
    honeypot = parsed.website; // bots fill this; humans leave it empty
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  if (honeypot) {
    // Silently accept but do nothing -- bot trap
    return NextResponse.json({ status: 'pending' });
  }

  if (!body || body.length < 2) {
    return NextResponse.json({ error: 'body too short' }, { status: 400 });
  }
  if (body.length > 2000) {
    return NextResponse.json({ error: 'body too long' }, { status: 400 });
  }

  const comment = await addComment(img.id, body, authorName || null, ipHash);
  await emit('comment.created', {
    comment: {
      id: comment.id,
      imageSlug: img.slug,
      body: comment.body,
      status: comment.status as 'pending' | 'approved' | 'rejected',
      createdAt: comment.createdAt.toISOString()
    }
  });
  return NextResponse.json({ status: 'pending', id: comment.id }, { status: 201 });
}
