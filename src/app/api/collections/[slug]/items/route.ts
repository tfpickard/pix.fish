import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import {
  addItemToCollection,
  getCollectionBySlug
} from '@/lib/db/queries/collections';
import { getImageBySlug } from '@/lib/db/queries/images';
import { hashIp, getRequestIp } from '@/lib/hash';
import { rateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// Add an image to a shelf. Body: { slug } (image slug) or { imageId }.
// Owner-only: we check the requester's hash against the shelf's ownerHash
// before mutating, so a leaked share URL can be browsed but not modified.
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

  const session = await auth();
  const requesterHash = session?.user?.id ?? ipHash;
  if (requesterHash !== collection.ownerHash) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let imageId: number | null = null;
  try {
    const body = (await req.json()) as { slug?: unknown; imageId?: unknown };
    if (typeof body.imageId === 'number' && Number.isFinite(body.imageId)) {
      imageId = body.imageId;
    } else if (typeof body.slug === 'string' && body.slug.trim().length > 0) {
      const img = await getImageBySlug(body.slug.trim());
      if (img) imageId = img.id;
    }
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  if (imageId === null) {
    return NextResponse.json({ error: 'image not found' }, { status: 404 });
  }

  const result = await addItemToCollection({ collectionId: collection.id, imageId });
  return NextResponse.json({
    inserted: result.inserted,
    collection: { slug: collection.slug }
  });
}
