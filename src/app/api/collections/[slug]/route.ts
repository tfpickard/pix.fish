import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import {
  getCollectionBySlug,
  getCollectionWithItems,
  isShelfOwner,
  renameCollection,
  toPublicCollection
} from '@/lib/db/queries/collections';
import { hashIp, getRequestIp } from '@/lib/hash';
import { rateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// Returns the public shape (slug, title, items, timestamps) -- no
// ownerHash or fingerprint. Anyone with the share link can read; the
// owner-identifying columns stay server-only.
export async function GET(_req: Request, ctx: { params: { slug: string } }) {
  const slug = ctx.params.slug;
  const collection = await getCollectionWithItems(slug);
  if (!collection) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ collection });
}

// Owner-only rename. Anonymous shelves require BOTH a matching ownerHash
// (ip_hash) and a matching fingerprint -- otherwise any visitor sharing
// a public IP behind the same NAT could rename the shelf if they had
// the URL. Signed-in users skip the fingerprint check; the session
// itself is the proof.
export async function PATCH(req: Request, ctx: { params: { slug: string } }) {
  const ip = getRequestIp(req);
  const ipHash = hashIp(ip);
  if (!rateLimit(`collection-edit:${ipHash}`, 30, 60_000)) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 });
  }

  const slug = ctx.params.slug;
  const collection = await getCollectionBySlug(slug);
  if (!collection) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  let title: string | null;
  let fingerprint: string | null = null;
  try {
    const body = (await req.json()) as { title?: unknown; fingerprint?: unknown };
    if (body.title === null) {
      title = null;
    } else if (typeof body.title === 'string') {
      const trimmed = body.title.trim();
      title = trimmed.length === 0 ? null : trimmed.slice(0, 100);
    } else {
      return NextResponse.json({ error: 'title must be string or null' }, { status: 400 });
    }
    if (typeof body.fingerprint === 'string') {
      fingerprint = body.fingerprint.slice(0, 64);
    }
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  const session = await auth();
  const requesterHash = session?.user?.id ?? ipHash;
  if (!isShelfOwner(collection, requesterHash, !!session?.user?.id, fingerprint)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const updated = await renameCollection({ id: collection.id, title });
  if (!updated) {
    // Row vanished between the read and the update (concurrent delete);
    // surface as 404 instead of returning {collection: null} 200, which
    // would be awkward for clients to interpret.
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ collection: toPublicCollection(updated) });
}
