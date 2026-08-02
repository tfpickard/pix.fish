import type { Job } from '@/lib/db/schema';
import { getProvider, loadUserProviderKeys } from '@/lib/ai';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { firstCaptionsByImageIds, type CaptionSnippet } from '@/lib/db/queries/captions';
import { getSiteAdminId } from '@/lib/db/queries/users';
import { getTopPaths, getWornEdgesFor, edgeKey } from '@/lib/db/queries/path-traffic';
import { getKnnPairsAmong, knnPairKey } from '@/lib/db/queries/knn';
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

  const rawEdges = await getTopPaths(TOP_EDGE_LIMIT);

  // Gate on graph-backed traffic BEFORE assembly. /api/traffic accepts
  // client-supplied walks, so without this an unauthenticated caller could post
  // arbitrary real image ids a few times and manufacture a public desire path
  // between images that were never walkable. Filtering pre-assembly (rather
  // than validating finished corridors) also stops a fabricated edge from
  // greedily attaching itself to an otherwise genuine corridor.
  //
  // This drops no legitimate traffic: the only emitter is a completed /connect
  // journey, whose node sequence findPath built out of these very kNN edges.
  const knnPairs = await getKnnPairsAmong(rawEdges.flatMap((e) => [e.srcId, e.dstId]));
  const edges = rawEdges.filter((e) => knnPairs.has(knnPairKey(e.srcId, e.dstId)));
  const rejected = rawEdges.length - edges.length;

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
  async function nameRoute(route: AssembledRoute): Promise<string | null> {
    if (!canCaption || captionBudget <= 0) return null;
    captionBudget--;
    try {
      const stops: RouteStop[] = route.nodeIds.map((id) => {
        const c = capMap.get(id);
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
    const caption = await nameRoute(route);

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
    const caption = await nameRoute(route);
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

  const retireSigs: string[] = [];
  const stillAlive: {
    edgeSig: string;
    strength: number;
    lifetime: number;
    lastWalkedAt: Date | null;
  }[] = [];

  for (const a of unverified) {
    const pairs = routeEdgePairs(a.nodeIds as number[]);
    let minVal = Infinity;
    let minLife = Infinity;
    let lastWalked: Date | null = null;
    let complete = pairs.length > 0;

    for (const p of pairs) {
      const worn = wornMap.get(edgeKey(p.srcId, p.dstId));
      if (!worn) {
        complete = false; // an edge with no live traffic breaks the chain
        break;
      }
      minVal = Math.min(minVal, worn.value);
      minLife = Math.min(minLife, worn.lifetime);
      if (!lastWalked || worn.lastUpdatedAt > lastWalked) lastWalked = worn.lastUpdatedAt;
    }

    if (complete && minVal >= promoteFloor) {
      // Still genuinely worn -- keep it and refresh its metrics from its own
      // edges so /paths doesn't order by frozen values.
      stillAlive.push({
        edgeSig: a.edgeSig,
        strength: minVal,
        lifetime: minLife,
        lastWalkedAt: lastWalked
      });
    } else {
      retireSigs.push(a.edgeSig);
    }
  }

  const revived = await refreshDesirePathsBulk(stillAlive);
  const retired = await retireDesirePathsBySigs(retireSigs, now);

  console.log(
    `desire.promote: ${promoted} promoted, ${refreshed} refreshed, ${revived} verified-kept, ` +
      `${renamed} renamed, ${retired} retired (${edges.length} graph-backed edges of ` +
      `${rawEdges.length}${rejected ? `, ${rejected} rejected as not kNN-backed` : ''}; ` +
      `${qualifying.length} corridors above floor ${promoteFloor}; ${toFile.length} filed; ` +
      `caption budget left ${captionBudget})`
  );
}
