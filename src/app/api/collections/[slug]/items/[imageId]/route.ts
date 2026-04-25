import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import {
  getCollectionBySlug,
  removeItemFromCollection
} from '@/lib/db/queries/collections';
import { hashIp, getRequestIp } from '@/lib/hash';
import { rateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// Owner-gated remove. Same auth pattern as POST /items.
export async function DELETE(
  req: Request,
  ctx: { params: { slug: string; imageId: string } }
) {
  const ip = getRequestIp(req);
  const ipHash = hashIp(ip);
  if (!rateLimit(`shelf-remove:${ipHash}`, 60, 60_000)) {
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

  const imageId = Number.parseInt(ctx.params.imageId, 10);
  if (!Number.isFinite(imageId)) {
    return NextResponse.json({ error: 'invalid imageId' }, { status: 400 });
  }

  const result = await removeItemFromCollection({
    collectionId: collection.id,
    imageId
  });
  return NextResponse.json(result);
}
