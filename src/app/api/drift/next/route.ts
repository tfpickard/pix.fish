import { NextResponse } from 'next/server';
import { readNsfwMode } from '@/lib/nsfw';
import { getCaptionVectorsForIds } from '@/lib/db/queries/taste';
import { randomUnseenDriftId } from '@/lib/db/queries/drift';
import { searchByVector } from '@/lib/db/queries/embeddings';
import { hydrateNodes } from '@/lib/db/queries/daily';
import { driftTarget, sanitizeTrajectory } from '@/lib/drift/engine';
import { hashIp, getRequestIp } from '@/lib/hash';
import { rateLimit } from '@/lib/rate-limit';
import type { PathNode } from '@/lib/knn-path-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// One step of a drift. The client posts its whole trajectory (visited ids +
// toward/away steer picks + lucidity); the server reconstructs the heading,
// steps to the next target point, and snaps to the nearest unseen real image.
// Stateless by design -- nothing about the walk is persisted server-side.
//
// Every candidate goes through searchByVector, which is archived + NSFW gated at
// the query layer, so a crafted body can only ever surface images this visitor
// is allowed to see. NSFW mode comes from the visitor's cookie, never the body.
export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }

  const ipHash = hashIp(getRequestIp(req));
  // A drift advances roughly every few seconds; 120/min leaves generous headroom
  // for an autoplaying session while bounding a scripted hammer.
  if (!rateLimit(`drift:${ipHash}`, 120, 60_000)) {
    return NextResponse.json({ error: 'rate limited' }, { status: 429 });
  }

  const { visited, toward, away, lucidity } = sanitizeTrajectory(
    (body ?? {}) as Record<string, unknown>
  );
  if (visited.length === 0) {
    return NextResponse.json({ error: 'no position' }, { status: 400 });
  }
  const nsfwMode = await readNsfwMode();
  const seen = new Set(visited);

  // Fetch the vectors we need: the current position, the one before it (for
  // momentum), and the steer picks. One batched, dimension-validated read.
  const need = [...new Set([...visited.slice(-2), ...toward, ...away])];
  const vecs = await getCaptionVectorsForIds(need);
  const position = vecs.get(visited[visited.length - 1]!);
  const previous = visited.length >= 2 ? vecs.get(visited[visited.length - 2]!) ?? null : null;
  const towardVecs = toward.map((id) => vecs.get(id)).filter((v): v is number[] => !!v);
  const awayVecs = away.map((id) => vecs.get(id)).filter((v): v is number[] => !!v);

  const nextNode = await pickNext({ position, previous, towardVecs, awayVecs, lucidity, seen, nsfwMode });
  if (!nextNode) {
    // The visitor has drifted past everything reachable in scope -- end cleanly.
    return NextResponse.json({ node: null, done: true });
  }
  return NextResponse.json({ node: nextNode });
}

async function pickNext(args: {
  position: number[] | undefined;
  previous: number[] | null;
  towardVecs: number[][];
  awayVecs: number[][];
  lucidity: number;
  seen: Set<number>;
  nsfwMode: Awaited<ReturnType<typeof readNsfwMode>>;
}): Promise<PathNode | null> {
  const { position, previous, towardVecs, awayVecs, lucidity, seen, nsfwMode } = args;

  let nextId: number | null = null;
  if (position) {
    const target = driftTarget(position, previous, towardVecs, awayVecs, lucidity);
    if (target) {
      // Pull a band of nearest images and take the first not recently seen, so a
      // step never lands back on an image still in the no-repeat window.
      const matches = await searchByVector(target, { limit: 100, kind: 'caption', nsfwMode });
      nextId = matches.map((m) => m.imageId).find((id) => !seen.has(id)) ?? null;
    }
  }

  // Fallback: degenerate heading, or the whole nearby band is already seen
  // (small/dense corpus). Query a random in-scope image the visitor hasn't seen
  // in the no-repeat window -- excluding server-side so we only ever return
  // `done` when the visible corpus is genuinely exhausted, never because a small
  // random sample happened to miss the remaining unseen frames.
  if (nextId === null) {
    nextId = await randomUnseenDriftId([...seen], nsfwMode);
  }
  if (nextId === null) return null;

  const meta = await hydrateNodes([nextId]);
  const node = meta.get(nextId);
  return node && node.blobUrl ? node : null;
}
