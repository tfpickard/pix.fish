import type { Job } from '@/lib/db/schema';
import { getProvider, loadUserProviderKeys } from '@/lib/ai';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { firstCaptionsByImageIds, type CaptionSnippet } from '@/lib/db/queries/captions';
import { getSiteAdminId } from '@/lib/db/queries/users';
import { getTopGraphBackedPaths, getWornEdgesFor, edgeKey } from '@/lib/db/queries/path-traffic';
import { getKnnPairsAmong, knnPairKey } from '@/lib/db/queries/knn';
import { hasInFlightJobOfType } from '@/lib/db/queries/jobs';
import {
  getDesirePathsBySigs,
  insertDesirePath,
  refreshDesirePathsBulk,
  setDesirePathCaptionIfNull,
  listActiveDesirePaths,
  retireDesirePathsBySigs,
  getDesirePathBySig
} from '@/lib/db/queries/desire-paths';
import { mintCollectionSlug } from '@/lib/collections/slug';
import { assembleRoutes, routeSignature, type AssembledRoute } from '@/lib/desire/assemble';
import { buildRouteNamePrompt, type RouteStop } from '@/lib/desire/caption';

// desire.promote: assemble the worn edges in path_traffic into corridors and
// file the ones above a strength floor as first-class desire_paths. Routes whose
// own edges have decayed below the floor are retired (hidden, never deleted).
// Newly-filed routes get a human slug and a best-effort clerk-authored name.
//
// Runs nightly via /api/cron/desire (deduped against an in-flight run) and
// on demand from /admin/desire/promote. Everything here is bounded so a mature
// traffic table still completes inside the worker budget: batched existence +
// bulk refresh, a cap on new filings, and a hard cap on caption LLM calls.
//
// Idempotent per run by construction: corridors upsert by edge_sig, and
// retirement is decided per-route from live traffic.

type Payload = {
  // Minimum chain strength (weakest-link decayed traffic) to file a route.
  promoteFloor?: number;
  // Minimum per-edge decayed value to be eligible for a chain.
  minEdgeValue?: number;
  // Safety cap on how many NEW routes to file in one run.
  maxRoutes?: number;
};

const DEFAULT_PROMOTE_FLOOR = 2; // ~two confirmed traversals of the weakest link
const DEFAULT_MIN_EDGE_VALUE = 1;
const DEFAULT_MAX_ROUTES = 100;
const TOP_EDGE_LIMIT = 2000;
const SLUG_RETRIES = 5;
// Hard ceiling on provider calls per run. Captioning is the only unbounded-cost
// step (one sequential LLM call per newly-named route), and the worker gives
// this job a 45s default budget -- so a first run against a mature table must
// not try to name every corridor at once. Unnamed routes display their slug and
// are picked up by a later run (see the retry pass below).
const MAX_CAPTIONS_PER_RUN = 12;

// The ordered (src,dst) pairs a stored corridor is made of.
function routeEdgePairs(nodeIds: number[]): { srcId: number; dstId: number }[] {
  const pairs: { srcId: number; dstId: number }[] = [];
  for (let i = 0; i < nodeIds.length - 1; i++) {
    pairs.push({ srcId: nodeIds[i]!, dstId: nodeIds[i + 1]! });
  }
  return pairs;
}

export async function desirePromoteHandler(job: Job): Promise<void> {
  const payload = (job.payload ?? {}) as Payload;
  const promoteFloor = payload.promoteFloor ?? DEFAULT_PROMOTE_FLOOR;
  const minEdgeValue = payload.minEdgeValue ?? DEFAULT_MIN_EDGE_VALUE;
  const maxRoutes = payload.maxRoutes ?? DEFAULT_MAX_ROUTES;

  // Gated in SQL, before the cap. /api/traffic accepts client-supplied walks,
  // so an unauthenticated caller could otherwise post arbitrary real image ids
  // and manufacture a public desire path between images that were never
  // walkable. Doing it pre-assembly (rather than validating finished corridors)
  // also stops a fabricated edge greedily attaching itself to a genuine one.
  //
  // Applying the gate inside the query rather than after it is the load-bearing
  // part: ranking raw rows first let a flood of high-value fake pairs occupy
  // the whole top-N, and filtering afterwards then left assembly with nothing
  // at all -- trading fabrication for starvation.
  //
  // This drops no legitimate traffic: the only emitter is a completed /connect
  // journey, whose node sequence findPath built out of these very kNN edges.
  const edges = await getTopGraphBackedPaths(TOP_EDGE_LIMIT);

  // Assemble at the promotion floor, not the (looser) minEdgeValue. Strength is
  // a chain's weakest edge, so any edge below promoteFloor would drag its whole
  // corridor below the floor -- and, because assembly is greedy, a weak edge can
  // get appended to a genuinely hot corridor and sink it. Extending only through
  // >= floor edges keeps qualifying corridors intact.
  const assemblyFloor = Math.max(minEdgeValue, promoteFloor);
  const qualifying = assembleRoutes(edges, { minEdgeValue: assemblyFloor }).filter(
    (r) => r.strength >= promoteFloor
  );

  // Resolve a text-capable provider once (best-effort; captions degrade to null
  // when no key is configured or the provider has no raw-text method).
  const cfg = await loadAiConfig();
  const keys = await loadUserProviderKeys(getSiteAdminId());
  const provider = getProvider('descriptions', cfg, keys);
  const canCaption = typeof provider?.text === 'function';
  let captionBudget = canCaption ? MAX_CAPTIONS_PER_RUN : 0;

  const now = new Date();
  const sigs = qualifying.map((r) => routeSignature(r.nodeIds));

  // ONE batched existence lookup for the whole qualifying set, instead of a
  // round-trip per corridor (which at scale could not finish inside the
  // worker's timeout before retirement was ever reached).
  const existing = await getDesirePathsBySigs(sigs);

  // Split into refresh vs file. Refresh is a cheap bulk UPDATE and is NOT
  // subject to maxRoutes -- capping it would freeze strength/lifetime for
  // routes beyond the cap while /paths keeps ordering by the stale values.
  const toRefresh: AssembledRoute[] = [];
  const toFile: AssembledRoute[] = [];
  for (const route of qualifying) {
    const sig = routeSignature(route.nodeIds);
    if (existing.has(sig)) toRefresh.push(route);
    else if (toFile.length < maxRoutes) toFile.push(route);
  }

  const refreshed = await refreshDesirePathsBulk(
    toRefresh.map((r) => ({
      edgeSig: routeSignature(r.nodeIds),
      strength: r.strength,
      lifetime: r.lifetime,
      // Real last-traversal time from path_traffic, not the job clock, so an
      // idle route doesn't look freshly walked after every nightly run.
      lastWalkedAt: r.lastWalkedAt
    }))
  );

  // Caption hydration covers both the routes we will file AND the already-filed
  // ones still missing a name, in one query.
  const needName = toRefresh.filter((r) => existing.get(routeSignature(r.nodeIds))?.caption == null);
  const capMap: Map<number, CaptionSnippet> =
    canCaption && (toFile.length > 0 || needName.length > 0)
      ? await firstCaptionsByImageIds([
          ...new Set([...toFile, ...needName].flatMap((r) => r.nodeIds))
        ])
      : new Map();

  // Ask the clerk to name a corridor. Returns null when captioning is off, the
  // per-run budget is spent, or the provider call fails -- all non-fatal.
  async function nameRoute(
    nodeIds: number[],
    caps: Map<number, CaptionSnippet>
  ): Promise<string | null> {
    if (!canCaption || captionBudget <= 0) return null;
    captionBudget--;
    try {
      const stops: RouteStop[] = nodeIds.map((id) => {
        const c = caps.get(id);
        return { slug: c?.slug ?? String(id), caption: c?.caption ?? '' };
      });
      const text = (await provider!.text!(buildRouteNamePrompt(stops))).trim();
      return text || null;
    } catch {
      return null; // best-effort: a later run retries this route.
    }
  }

  let promoted = 0;
  for (const route of toFile) {
    const sig = routeSignature(route.nodeIds);
    const caption = await nameRoute(route.nodeIds, capMap);

    let filed = false;
    for (let attempt = 0; attempt < SLUG_RETRIES && !filed; attempt++) {
      try {
        await insertDesirePath({
          slug: mintCollectionSlug(),
          edgeSig: sig,
          nodeIds: route.nodeIds,
          caption,
          provider: caption ? cfg.descriptions.provider : null,
          model: caption ? cfg.descriptions.model : null,
          strength: route.strength,
          lifetime: route.lifetime,
          lastWalkedAt: route.lastWalkedAt
        });
        filed = true;
        promoted++;
      } catch (err) {
        // Retry only slug collisions; an edge_sig collision means it now exists,
        // so stop trying to insert it.
        const existsNow = await getDesirePathBySig(sig);
        if (existsNow) break;
        if (attempt === SLUG_RETRIES - 1) throw err;
      }
    }
  }

  // Retry naming for routes filed earlier without a caption. Without this a
  // route that hit a provider blip (or the budget) on its first run would show
  // its generated slug forever -- the refresh branch never revisits the name.
  let renamed = 0;
  for (const route of needName) {
    if (captionBudget <= 0) break;
    const caption = await nameRoute(route.nodeIds, capMap);
    if (!caption) continue;
    await setDesirePathCaptionIfNull(
      routeSignature(route.nodeIds),
      caption,
      cfg.descriptions.provider,
      cfg.descriptions.model
    );
    renamed++;
  }

  // ---- Edge-verified retirement -------------------------------------------
  // A corridor dies when ITS OWN EDGES decay, not when it fails to reappear in
  // this run's greedy partition. Absence is not evidence of decay: a hotter
  // branch can consume a shared edge into a different chain, and the top-N
  // traffic sample can omit a still-qualifying edge entirely -- both of which
  // would wrongly retire a path people are actively walking. So we check every
  // active route against live traffic for the edges it actually stores.
  const actives = await listActiveDesirePaths();
  const refreshedSigs = new Set(toRefresh.map((r) => routeSignature(r.nodeIds)));
  const unverified = actives.filter((a) => !refreshedSigs.has(a.edgeSig));

  const wornMap = await getWornEdgesFor(
    unverified.flatMap((a) => routeEdgePairs(a.nodeIds as number[]))
  );

  // Retention needs the same graph gate as promotion. Traffic alone is not
  // evidence a corridor is walkable: a path promoted from fabricated traffic
  // before this gate existed, or one whose edges vanished in a later kNN
  // rebuild, would otherwise be kept alive indefinitely by anyone continuing to
  // post its pairs -- the gate above only ever sees freshly assembled routes.
  const activeKnnPairs = await getKnnPairsAmong(
    unverified.flatMap((a) => a.nodeIds as number[])
  );

  // ...but ONLY when the graph is actually trustworthy. knn.rebuild does
  // clearAllKnnEdges() and insertKnnEdges() as separate awaits, and the worker
  // permits overlapping drains, so this job can observe an empty or half-filled
  // graph mid-rebuild. Treating that as decay would be catastrophic rather than
  // merely wrong: with the graph empty, getTopGraphBackedPaths returns nothing,
  // so `qualifying` is empty, EVERY active path lands in `unverified`, and the
  // gate would retire the entire corpus of corridors in one run.
  //
  // When a rebuild is in flight -- or the graph is simply empty, which is the
  // same state observed without the job row -- fall back to the traffic test
  // alone for this run. A fabricated path surviving one extra night is a far
  // cheaper mistake than mass-retiring paths people are walking, and the next
  // run re-applies the gate against a settled graph.
  const graphTrustworthy =
    !(await hasInFlightJobOfType('knn.rebuild')) && activeKnnPairs.size > 0;

  const retireSigs: string[] = [];
  const stillAlive: {
    edgeSig: string;
    strength: number;
    lifetime: number;
    lastWalkedAt: Date | null;
  }[] = [];
  // Survivors kept alive purely by edge verification, still without a name.
  // They never enter `qualifying`, so the rename pass above -- which is built
  // from toRefresh -- structurally cannot reach them.
  const survivorsNeedName: { edgeSig: string; nodeIds: number[] }[] = [];

  for (const a of unverified) {
    const pairs = routeEdgePairs(a.nodeIds as number[]);
    let minVal = Infinity;
    let minLife = Infinity;
    let lastWalked: Date | null = null;
    let complete = pairs.length > 0;

    for (const p of pairs) {
      if (graphTrustworthy && !activeKnnPairs.has(knnPairKey(p.srcId, p.dstId))) {
        complete = false; // not walkable in the current graph -- retire it
        break;
      }
      const worn = wornMap.get(edgeKey(p.srcId, p.dstId));
      if (!worn) {
        complete = false; // an edge with no live traffic breaks the chain
        break;
      }
      minVal = Math.min(minVal, worn.value);
      minLife = Math.min(minLife, worn.lifetime);
      if (!lastWalked || worn.lastUpdatedAt > lastWalked) lastWalked = worn.lastUpdatedAt;
    }

    if (complete && minVal >= assemblyFloor) {
      // Still genuinely worn -- keep it and refresh its metrics from its own
      // edges so /paths doesn't order by frozen values.
      stillAlive.push({
        edgeSig: a.edgeSig,
        strength: minVal,
        lifetime: minLife,
        lastWalkedAt: lastWalked
      });
      if (a.caption == null) {
        survivorsNeedName.push({ edgeSig: a.edgeSig, nodeIds: a.nodeIds as number[] });
      }
    } else {
      retireSigs.push(a.edgeSig);
    }
  }

  const revived = await refreshDesirePathsBulk(stillAlive);
  const retired = await retireDesirePathsBySigs(retireSigs, now);

  // Second rename pass, for the survivors above. Without it, a route that lost
  // its first naming attempt to a provider blip and then stopped resurfacing in
  // the greedy partition would display its generated slug forever -- which is
  // precisely what the retry pass exists to prevent, so leaving this gap would
  // make that guarantee true only for the routes that needed it least.
  // Needs its own caption hydration: capMap was built from toFile + needName,
  // and by construction none of these appear in either.
  if (captionBudget > 0 && survivorsNeedName.length > 0) {
    const survivorCaps = await firstCaptionsByImageIds([
      ...new Set(survivorsNeedName.flatMap((s) => s.nodeIds))
    ]);
    for (const s of survivorsNeedName) {
      if (captionBudget <= 0) break;
      const caption = await nameRoute(s.nodeIds, survivorCaps);
      if (!caption) continue;
      await setDesirePathCaptionIfNull(
        s.edgeSig,
        caption,
        cfg.descriptions.provider,
        cfg.descriptions.model
      );
      renamed++;
    }
  }

  console.log(
    `desire.promote: ${promoted} promoted, ${refreshed} refreshed, ${revived} verified-kept, ` +
      `${renamed} renamed, ${retired} retired (${edges.length} graph-backed edges; ` +
      `${qualifying.length} corridors above floor ${promoteFloor}; ${toFile.length} filed; ` +
      `caption budget left ${captionBudget})`
  );
}
