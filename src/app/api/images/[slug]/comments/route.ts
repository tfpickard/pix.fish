import { checkBotId } from 'botid/server';
import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { getImageBySlug } from '@/lib/db/queries/images';
import { addComment, listApprovedComments } from '@/lib/db/queries/comments';
import { getGalleryDefaults } from '@/lib/db/queries/gallery-config';
import { getSiteAdminId } from '@/lib/db/queries/users';
import { hashIp, getRequestIp, getRequestGeo } from '@/lib/hash';
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

  // 3 comments per IP per 10 minutes. Signed-in users share the IP bucket;
  // one account on a shared IP still shouldn't be able to flood. The bucket
  // is keyed on the hash, not the user id, so this is correct without
  // change.
  if (!rateLimit(`comment:${ipHash}`, 3, 10 * 60_000)) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 });
  }

  // Guests may comment without signing in, so before BotID the per-IP throttle
  // was the only thing between a spam script and the moderation queue. After
  // the throttle deliberately: checkBotId() is a network round trip and a
  // client already over its 3-per-10-minutes should not cost us one.
  const { isBot } = await checkBotId();
  if (isBot) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
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

  // Signed-in users get their identity from the session and skip moderation.
  // Their handle is the canonical display name -- the form's authorName is
  // ignored. Guests keep the optional name plus auto-captured geo from
  // Vercel's edge headers (nulls in dev / non-Vercel hosts).
  const session = await auth();
  const userId = session?.user?.id ?? null;
  const isUser = !!userId;
  // Guests default to the moderation queue ('pending') unless the owner has
  // flipped the site-wide auto-approve toggle in /admin/gallery. Soft-fails
  // to the safe default (moderated) if the config read throws.
  const autoApprove = await getGalleryDefaults(getSiteAdminId())
    .then((d) => d.autoApproveComments)
    .catch(() => false);
  const status = isUser || autoApprove ? 'approved' : 'pending';
  const persistedAuthorName = isUser ? null : authorName || null;
  const geo = isUser
    ? { city: null, region: null, country: null }
    : getRequestGeo(req);

  const comment = await addComment({
    imageId: img.id,
    userId,
    authorName: persistedAuthorName,
    body,
    ipHash,
    status,
    geoCity: geo.city,
    geoRegion: geo.region,
    geoCountry: geo.country
  });

  await emit('comment.created', {
    comment: {
      id: comment.id,
      imageSlug: img.slug,
      body: comment.body,
      status: comment.status as 'pending' | 'approved' | 'rejected',
      createdAt: comment.createdAt.toISOString(),
      // Additive: existing consumers ignore unknown fields. Signed-in
      // comments carry a userId + handle; guests carry name + geo.
      author: isUser
        ? {
            kind: 'user' as const,
            userId,
            handle: session?.user?.handle ?? null
          }
        : {
            kind: 'guest' as const,
            name: persistedAuthorName,
            city: geo.city,
            region: geo.region,
            country: geo.country
          }
    }
  });
  return NextResponse.json({ status, id: comment.id }, { status: 201 });
}
