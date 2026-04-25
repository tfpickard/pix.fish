import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { createCollection, toPublicCollection } from '@/lib/db/queries/collections';
import { hashIp, getRequestIp } from '@/lib/hash';
import { rateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// Mint a new shelf for the requesting visitor. The response strips
// ownerHash and fingerprint so the client never sees the IP-derived
// identifier even though it kicked off the request -- both fields are
// server-only.
export async function POST(req: Request) {
  const ip = getRequestIp(req);
  const ipHash = hashIp(ip);
  if (!rateLimit(`collection-mint:${ipHash}`, 5, 60_000)) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 });
  }

  const session = await auth();
  const ownerHash = session?.user?.id ?? ipHash;

  let fingerprint: string | null = null;
  let title: string | null = null;
  try {
    const body = (await req.json().catch(() => null)) as
      | { fingerprint?: unknown; title?: unknown }
      | null;
    if (body && typeof body.fingerprint === 'string') {
      fingerprint = body.fingerprint.slice(0, 64);
    }
    if (body && typeof body.title === 'string' && body.title.trim().length > 0) {
      title = body.title.trim().slice(0, 100);
    }
  } catch {
    // empty body is fine; defaults stand
  }

  const collection = await createCollection({ ownerHash, fingerprint, title });
  return NextResponse.json(
    { collection: toPublicCollection(collection) },
    { status: 201 }
  );
}
