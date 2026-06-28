import { NextResponse } from 'next/server';
import { hashIp, getRequestIp } from '@/lib/hash';
import { rateLimit } from '@/lib/rate-limit';
import { recordTasteVote, embeddedSubset } from '@/lib/db/queries/taste';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Records one pairwise taste vote (the picked image beat the passed-over one).
// Best-effort: the quiz fires these in the background and ignores the result,
// so a failure (or an un-migrated table) never affects play. IP-hash rate
// limited like the other anonymous engagement endpoints.
export async function POST(req: Request): Promise<NextResponse> {
  let body: { winner?: unknown; loser?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const winner = Number(body.winner);
  const loser = Number(body.loser);
  if (!Number.isInteger(winner) || !Number.isInteger(loser) || winner <= 0 || loser <= 0 || winner === loser) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const ipHash = hashIp(getRequestIp(req));
  // A full quiz is ~10 votes; 60/min leaves generous headroom while bounding abuse.
  if (!rateLimit(`tastevote:${ipHash}`, 60, 60_000)) {
    return NextResponse.json({ ok: false, error: 'rate limited' }, { status: 429 });
  }

  // Only rank images the quiz actually serves: both sides must be caption-
  // embedded, so a scripted client can't forge votes for non-quiz images.
  try {
    const embedded = await embeddedSubset([winner, loser]);
    if (!embedded.has(winner) || !embedded.has(loser)) {
      return NextResponse.json({ ok: false }, { status: 422 });
    }
  } catch {
    // Embeddings table unreachable -- skip the check rather than block play;
    // recordTasteVote is itself best-effort and degrades gracefully.
  }

  const ok = await recordTasteVote(winner, loser, ipHash);
  return NextResponse.json({ ok });
}
