import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import {
  addItemToCollection,
  getCollectionBySlug,
  isShelfOwner
} from '@/lib/db/queries/collections';
import { hashIp, getRequestIp } from '@/lib/hash';
import { rateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// Add an image to a shelf. Body: { imageId, fingerprint }. We require
// imageId (not slug) because image slugs are per-owner unique on this
// site -- two users can have /u/alice/sunset and /u/bob/sunset, so a
// global slug lookup would resolve to the wrong row half the time.
// Anonymous mutations also require the fingerprint to match the stored
// one so a shared-IP visitor with the URL can't tamper with the shelf.
export async function POST(req: Request, ctx: { params: { slug: string } }) {
  const ip = getRequestIp(req);
  const ipHash = hashIp(ip);
  if (!rateLimit(`shelf-add:${ipHash}`, 60, 60_000)) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 });
  }

  const collection = await getCollectionBySlug(ctx.params.slug);
  if (!collection) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  let imageId: number | null = null;
  let fingerprint: string | null = null;
  try {
    const body = (await req.json()) as { imageId?: unknown; fingerprint?: unknown };
    if (typeof body.imageId === 'number' && Number.isFinite(body.imageId)) {
      imageId = body.imageId;
    }
    if (typeof body.fingerprint === 'string') {
      fingerprint = body.fingerprint.slice(0, 64);
    }
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  if (imageId === null) {
    return NextResponse.json({ error: 'imageId required' }, { status: 400 });
  }

  const session = await auth();
  const requesterHash = session?.user?.id ?? ipHash;
  if (!isShelfOwner(collection, requesterHash, !!session?.user?.id, fingerprint)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const result = await addItemToCollection({ collectionId: collection.id, imageId });
  return NextResponse.json({
    inserted: result.inserted,
    collection: { slug: collection.slug }
  });
}
