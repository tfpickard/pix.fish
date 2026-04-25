import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import {
  getCollectionBySlug,
  isShelfOwner,
  removeItemFromCollection
} from '@/lib/db/queries/collections';
import { hashIp, getRequestIp } from '@/lib/hash';
import { rateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// Owner-gated remove. Anonymous shelves require fingerprint match;
// see the rename and add routes for the same authorization rule.
// Fingerprint is read from a header (DELETE bodies don't get parsed
// reliably across all clients/CDNs); the standard `x-pix-fp` header
// covers it.
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

  const fingerprintHeader = req.headers.get('x-pix-fp');
  const fingerprint = fingerprintHeader ? fingerprintHeader.slice(0, 64) : null;

  const session = await auth();
  const requesterHash = session?.user?.id ?? ipHash;
  if (!isShelfOwner(collection, requesterHash, !!session?.user?.id, fingerprint)) {
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
