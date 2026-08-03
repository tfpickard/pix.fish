import type { Job } from '@/lib/db/schema';
import { getProvider, loadUserProviderKeys } from '@/lib/ai';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { firstCaptionsByImageIds, type CaptionSnippet } from '@/lib/db/queries/captions';
import { getSiteAdminId } from '@/lib/db/queries/users';
import { getTopGraphBackedPaths, getWornEdgesFor, edgeKey } from '@/lib/db/queries/path-traffic';
import { getKnnPairsAmong, hasImageKnnEdges, knnPairKey } from '@/lib/db/queries/knn';
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
// are picked up by a later run.
const MAX_CAPTIONS_PER_RUN = 12;
// ...but a call count alone does not bound wall time, and neither provider's
// text() carries a deadline. Twelve calls at four seconds each overruns the
// worker's 45s cap on their own, so the two guards below make the naming phase
// bounded in time as well as in requests: no call may start unless it could
// still finish before the hard deadline, and no single call may hang past its
// own cap. Both are measured from handler entry.
const CAPTION_CALL_TIMEOUT_MS = 8_000;
const NAMING_HARD_DEADLINE_MS = 40_000;

// Bound a single provider call. Neither Anthropic's nor OpenAI's text() takes a
// deadline, so without this one hung request could consume the whole handler
// budget no matter how few calls the run was allowed to make. The promise is
// left to settle on its own; only our wait for it ends.
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`caption call exceeded ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

// The ordered (src,dst) pairs a stored corridor is made of.
function routeEdgePairs(nodeIds: number[]): { srcId: number; dstId: number }[] {
  const pairs: { srcId: number; dstId: number }[] = [];
  for (let i = 0; i < nodeIds.length - 1; i++) {
    pairs.push({ srcId: nodeIds[i]!, dstId: nodeIds[i + 1]! });
  }
  return pairs;
}

export async function desirePromoteHandler(job: Job): Promise<void> {
  const startedAt = Date.now();
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

  // Every corridor that will need a name once the lifecycle writes are done.
  // Collected here, named at the very end -- see the naming phase below for why
  // no provider call may happen before retirement has been written.
  const needName = toRefresh.filter((r) => existing.get(routeSignature(r.nodeIds))?.caption == null);
  const pendingNames: { edgeSig: string; nodeIds: number[] }[] = needName.map((r) => ({
    edgeSig: routeSignature(r.nodeIds),
    nodeIds: r.nodeIds
  }));

  // File new corridors with no caption. Naming used to happen inline here, which
  // put twelve sequential provider calls in front of the retirement writes below
  // -- so a slow provider blew the worker's 45s cap mid-loop and the run died
  // having filed some routes but retired none, leaving decayed paths public and
  // re-doing the same partial work on every retry. Filing unnamed is not a
  // downgrade: setDesirePathCaptionIfNull backfills the name in the same run,
  // and a route that loses its name to a blip was always going to display its
  // slug until a later run.
  let promoted = 0;
  for (const route of toFile) {
    const sig = routeSignature(route.nodeIds);

    let filed = false;
    for (let attempt = 0; attempt < SLUG_RETRIES && !filed; attempt++) {
      try {
        await insertDesirePath({
          slug: mintCollectionSlug(),
          edgeSig: sig,
          nodeIds: route.nodeIds,
          caption: null,
          provider: null,
          model: null,
          strength: route.strength,
          lifetime: route.lifetime,
          lastWalkedAt: route.lastWalkedAt
        });
        filed = true;
        promoted++;
        pendingNames.push({ edgeSig: sig, nodeIds: route.nodeIds });
      } catch (err) {
        // Retry only slug collisions; an edge_sig collision means it now exists,
        // so stop trying to insert it.
        const existsNow = await getDesirePathBySig(sig);
        if (existsNow) break;
        if (attempt === SLUG_RETRIES - 1) throw err;
      }
    }
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
  // Health is measured against the graph itself, NOT against how many of these
  // candidates matched. Deriving it from `activeKnnPairs` inverted the gate in
  // the one case it exists for: when the only unverified route is a fabricated
  // corridor whose nodes have no adjacency, "no matches" is the finding, not
  // evidence the graph is down -- yet it read as untrustworthy, skipped the
  // check, and let forged traffic keep that route public forever.
  //
  // When a rebuild is in flight -- or the graph is genuinely empty -- fall back
  // to the traffic test alone for this run. A fabricated path surviving one
  // extra night is a far cheaper mistake than mass-retiring paths people are
  // walking, and the next run re-applies the gate against a settled graph.
  const graphTrustworthy =
    !(await hasInFlightJobOfType('knn.rebuild')) && (await hasImageKnnEdges());

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

  // ---- Naming (best-effort, strictly last) --------------------------------
  // Every write that decides what the public /paths page shows has now been
  // committed. Naming is the only step that calls a provider, so running it
  // last means overrunning the budget costs at most some slugs displayed
  // instead of names -- never an unretired path or a half-applied run.
  //
  // Three groups converge here, all handled by one pass and one hydration
  // query: newly filed routes, refreshed routes that never got a name, and
  // survivors kept alive by edge verification alone (which never enter
  // `qualifying`, so nothing built from it could reach them).
  pendingNames.push(...survivorsNeedName);

  let renamed = 0;
  if (canCaption && captionBudget > 0 && pendingNames.length > 0) {
    const caps = await firstCaptionsByImageIds([
      ...new Set(pendingNames.flatMap((p) => p.nodeIds))
    ]);

    for (const p of pendingNames) {
      if (captionBudget <= 0) break;
      // Only start a call that can still finish inside the deadline, so the
      // handler cannot be pushed past the worker cap by its own last request.
      if (Date.now() - startedAt + CAPTION_CALL_TIMEOUT_MS > NAMING_HARD_DEADLINE_MS) break;
      captionBudget--;

      let caption: string | null = null;
      try {
        const stops: RouteStop[] = p.nodeIds.map((id) => {
          const c = caps.get(id);
          return { slug: c?.slug ?? String(id), caption: c?.caption ?? '' };
        });
        const text = await withDeadline(
          provider!.text!(buildRouteNamePrompt(stops)),
          CAPTION_CALL_TIMEOUT_MS
        );
        caption = text.trim() || null;
      } catch {
        continue; // best-effort: a later run retries this route.
      }

      if (!caption) continue;
      await setDesirePathCaptionIfNull(
        p.edgeSig,
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
