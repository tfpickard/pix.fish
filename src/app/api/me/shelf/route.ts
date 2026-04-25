import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import {
  addItemToCollection,
  findOrCreateDefaultShelf,
  removeItemFromCollection
} from '@/lib/db/queries/collections';
import { getImageBySlug } from '@/lib/db/queries/images';
import { hashIp, getRequestIp } from '@/lib/hash';
import { rateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// One-shot "save to my shelf" endpoint. Resolves (or creates) the
// visitor's default shelf and adds the requested image in a single
// round-trip. The returned slug is what the client persists in
// localStorage so subsequent saves skip the lookup. POST adds, DELETE
// removes; both are idempotent (already-present add is a no-op insert,
// already-absent remove returns removed=false).
export async function POST(req: Request) {
  const ip = getRequestIp(req);
  const ipHash = hashIp(ip);
  if (!rateLimit(`shelf-add:${ipHash}`, 60, 60_000)) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 });
  }

  const session = await auth();
  const ownerHash = session?.user?.id ?? ipHash;

  let imageSlug: string | null = null;
  let fingerprint: string | null = null;
  try {
    const body = (await req.json()) as { slug?: unknown; fingerprint?: unknown };
    if (typeof body.slug === 'string' && body.slug.trim().length > 0) {
      imageSlug = body.slug.trim();
    }
    if (typeof body.fingerprint === 'string') {
      fingerprint = body.fingerprint.slice(0, 64);
    }
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  if (!imageSlug) {
    return NextResponse.json({ error: 'slug required' }, { status: 400 });
  }

  const image = await getImageBySlug(imageSlug);
  if (!image) {
    return NextResponse.json({ error: 'image not found' }, { status: 404 });
  }

  const { collection, created } = await findOrCreateDefaultShelf({
    ownerHash,
    fingerprint
  });
  const result = await addItemToCollection({
    collectionId: collection.id,
    imageId: image.id
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

  let imageSlug: string | null = null;
  let fingerprint: string | null = null;
  try {
    const body = (await req.json()) as { slug?: unknown; fingerprint?: unknown };
    if (typeof body.slug === 'string') imageSlug = body.slug.trim();
    if (typeof body.fingerprint === 'string') {
      fingerprint = body.fingerprint.slice(0, 64);
    }
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  if (!imageSlug) {
    return NextResponse.json({ error: 'slug required' }, { status: 400 });
  }

  const image = await getImageBySlug(imageSlug);
  if (!image) {
    return NextResponse.json({ error: 'image not found' }, { status: 404 });
  }

  // We *don't* create a shelf here; if the visitor never had one, the
  // remove is a 404 by design.
  const { collection, created } = await findOrCreateDefaultShelf({
    ownerHash,
    fingerprint
  });
  if (created) {
    return NextResponse.json({ removed: false }, { status: 200 });
  }
  const result = await removeItemFromCollection({
    collectionId: collection.id,
    imageId: image.id
  });
  return NextResponse.json({
    removed: result.removed,
    shelf: { slug: collection.slug }
  });
}
