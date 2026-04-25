import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { auth } from '@/lib/auth';
import {
  addItemToCollection,
  findDefaultShelf,
  findOrCreateDefaultShelf,
  removeItemFromCollection
} from '@/lib/db/queries/collections';
import { db } from '@/lib/db/client';
import { images } from '@/lib/db/schema';
import { hashIp, getRequestIp } from '@/lib/hash';
import { rateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// One-shot "save to my shelf" endpoint. The client sends imageId (not
// slug) because slugs are per-owner unique on this site -- a global
// slug lookup would resolve /u/alice/sunset to /u/bob/sunset half the
// time. POST resolves-or-creates the visitor's shelf and adds the
// image. DELETE is find-only: a first-time visitor unsaving an image
// they never saved gets removed=false, not a freshly-created empty
// shelf as a side effect.
export async function POST(req: Request) {
  const ip = getRequestIp(req);
  const ipHash = hashIp(ip);
  if (!rateLimit(`shelf-add:${ipHash}`, 60, 60_000)) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 });
  }

  const session = await auth();
  const ownerHash = session?.user?.id ?? ipHash;

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

  // Cheap existence check so we don't insert a collection_item pointing
  // at a non-existent image (FK would error, but a 404 here is clearer).
  const [exists] = await db
    .select({ id: images.id })
    .from(images)
    .where(eq(images.id, imageId))
    .limit(1);
  if (!exists) {
    return NextResponse.json({ error: 'image not found' }, { status: 404 });
  }

  const { collection, created } = await findOrCreateDefaultShelf({
    ownerHash,
    fingerprint
  });
  const result = await addItemToCollection({
    collectionId: collection.id,
    imageId
  });

  return NextResponse.json({
    shelf: {
      slug: collection.slug,
      title: collection.title,
      created
    },
    inserted: result.inserted
  });
}

export async function DELETE(req: Request) {
  const ip = getRequestIp(req);
  const ipHash = hashIp(ip);
  if (!rateLimit(`shelf-remove:${ipHash}`, 60, 60_000)) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 });
  }

  const session = await auth();
  const ownerHash = session?.user?.id ?? ipHash;

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

  // Find-only: a first-time visitor with no shelf gets a clean
  // removed=false. We never create a shelf as a side effect of an
  // unsave attempt.
  const collection = await findDefaultShelf({ ownerHash, fingerprint });
  if (!collection) {
    return NextResponse.json({ removed: false });
  }
  const result = await removeItemFromCollection({
    collectionId: collection.id,
    imageId
  });
  return NextResponse.json({
    removed: result.removed,
    shelf: { slug: collection.slug }
  });
}
