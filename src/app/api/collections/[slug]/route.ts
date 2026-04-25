import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import {
  getCollectionBySlug,
  getCollectionWithItems,
  renameCollection
} from '@/lib/db/queries/collections';
import { hashIp, getRequestIp } from '@/lib/hash';
import { rateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: { slug: string } }) {
  const slug = ctx.params.slug;
  const collection = await getCollectionWithItems(slug);
  if (!collection) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  return NextResponse.json({ collection });
}

// Owner-only rename. We compare the request's owner-hash (signed-in
// user.id, or the visitor's ip_hash for anonymous shelves) against the
// stored ownerHash on the collection. No third-party can rename a
// shelf they don't own even if they can read it via the share URL.
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

  const session = await auth();
  const requesterHash = session?.user?.id ?? ipHash;
  if (requesterHash !== collection.ownerHash) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let title: string | null;
  try {
    const body = (await req.json()) as { title?: unknown };
    if (body.title === null) {
      title = null;
    } else if (typeof body.title === 'string') {
      const trimmed = body.title.trim();
      title = trimmed.length === 0 ? null : trimmed.slice(0, 100);
    } else {
      return NextResponse.json({ error: 'title must be string or null' }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  const updated = await renameCollection({ id: collection.id, title });
  return NextResponse.json({ collection: updated });
}
