import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { createCollection } from '@/lib/db/queries/collections';
import { hashIp, getRequestIp } from '@/lib/hash';
import { rateLimit } from '@/lib/rate-limit';

export const dynamic = 'force-dynamic';

// Mint a new shelf for the requesting visitor. We don't auto-bind the
// just-minted shelf to the visitor's localStorage on the server; the
// client persists `pix_shelf_slug` on its own (see save-to-shelf.tsx).
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
  return NextResponse.json({ collection }, { status: 201 });
}
