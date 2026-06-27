import type { Metadata } from 'next';
import { readNsfwMode } from '@/lib/nsfw';
import { getGraphNodeIds, getScopedAdjacency, hydrateNodes } from '@/lib/db/queries/daily';
import { bfsDistances, dailyNumber, pickDaily } from '@/lib/daily/puzzle';
import { DailyGame } from '@/components/daily-game';
import type { PathNode } from '@/lib/knn-path-types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'the daily',
  description:
    'A daily puzzle: walk the gallery from one image to another through its semantic graph, guided only by hotter / colder.',
  alternates: { canonical: '/daily' },
  robots: { index: true, follow: true }
};

export default async function DailyPage() {
  const nsfwMode = await readNsfwMode();
  const nodeIds = await getGraphNodeIds(nsfwMode);
  const adj = await getScopedAdjacency(nodeIds, nsfwMode);

  // Today at UTC midnight -> a stable per-day seed + puzzle number. UTC keeps
  // "the daily" the same puzzle for everyone regardless of timezone.
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const num = dailyNumber(utcMidnight);

  const pick = pickDaily(nodeIds, adj, dateStr);

  if (!pick) {
    return (
      <div className="space-y-4 pt-8">
        <h1 className="font-fungal-lite text-3xl text-ink-100">the daily</h1>
        <p className="font-mono text-xs text-ink-500">
          not enough connected images in the graph yet -- check back once more have been added (or a
          site admin can rebuild the graph at /admin/knn).
        </p>
      </div>
    );
  }

  // distance-from-B powers the hot/cold feedback; hydrate every node up front
  // so the client game never needs a round trip mid-play.
  const distFromB = bfsDistances(adj, pick.b);
  const nodeMeta = await hydrateNodes(nodeIds);

  // Sum the cosine weights along the optimal path so the end-screen replay can
  // show a real "total distance" rather than the integer hop count.
  let optimalDist = 0;
  for (let i = 0; i + 1 < pick.path.length; i++) {
    const e = (adj.get(pick.path[i]!) ?? []).find((x) => x.dstId === pick.path[i + 1]);
    optimalDist += e?.dist ?? 0;
  }

  // Serializable payloads (plain records; JSON stringifies number keys).
  const adjacency: Record<number, number[]> = {};
  for (const [id, edges] of adj) adjacency[id] = edges.map((e) => e.dstId);
  const distFrom: Record<number, number> = {};
  for (const [id, d] of distFromB) distFrom[id] = d;
  const nodes: Record<number, PathNode> = {};
  for (const id of nodeIds) {
    const m = nodeMeta.get(id);
    if (m && m.blobUrl) nodes[id] = m;
  }
  const optimalPath = pick.path.map((id) => nodes[id]).filter(Boolean) as PathNode[];

  return (
    <DailyGame
      dailyNumber={num}
      aId={pick.a}
      bId={pick.b}
      par={pick.par}
      adjacency={adjacency}
      distFromB={distFrom}
      nodes={nodes}
      optimalPath={optimalPath}
      optimalDist={optimalDist}
    />
  );
}
