import { NextResponse } from 'next/server';
import { readNsfwMode } from '@/lib/nsfw';
import { fusePair, activeFuseIds } from '@/lib/db/queries/fuse';
import { hydrateNodes } from '@/lib/db/queries/daily';
import { hashIp, getRequestIp } from '@/lib/hash';
import { rateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Fuse two images -> the specimen nearest the centroid of their caption
// embeddings. Both parents must be valid fuse elements (caption-embedded, not
// archived, visible under the visitor's NSFW mode); the result comes back
// through the same gated path, so a crafted body can only ever surface an image
// this visitor is allowed to see. NSFW mode is read from the cookie, never the
// body. Deterministic, so the same pair always yields the same fusion.
export async function POST(req: Request): Promise<NextResponse> {
  let body: { a?: unknown; b?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  const a = Number(body.a);
  const b = Number(body.b);
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0 || a === b) {
    return NextResponse.json({ error: 'two distinct image ids required' }, { status: 400 });
  }

  const ipHash = hashIp(getRequestIp(req));
  // Fusing is one tap per combination; 90/min is generous for active play while
  // bounding a scripted hammer.
  if (!rateLimit(`fuse:${ipHash}`, 90, 60_000)) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 });
  }

  const nsfwMode = await readNsfwMode();

  // Both parents must be real, visible fuse elements -- reject forged/hidden ids.
  const allowed = await activeFuseIds([a, b], nsfwMode);
  if (!allowed.has(a) || !allowed.has(b)) {
    return NextResponse.json({ error: 'unfusable ids' }, { status: 422 });
  }

  const fusionId = await fusePair(a, b, nsfwMode);
  if (fusionId === null) {
    return NextResponse.json({ node: null });
  }
  const meta = await hydrateNodes([fusionId]);
  const node = meta.get(fusionId);
  if (!node || !node.blobUrl) {
    return NextResponse.json({ node: null });
  }
  return NextResponse.json({ node });
}
