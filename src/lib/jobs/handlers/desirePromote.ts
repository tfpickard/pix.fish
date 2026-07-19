import type { Job } from '@/lib/db/schema';
import { getProvider, loadUserProviderKeys } from '@/lib/ai';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { firstCaptionsByImageIds, type CaptionSnippet } from '@/lib/db/queries/captions';
import { getSiteAdminId } from '@/lib/db/queries/users';
import { getTopPaths } from '@/lib/db/queries/path-traffic';
import {
  getDesirePathBySig,
  insertDesirePath,
  refreshDesirePath,
  retireDesirePathsExcept
} from '@/lib/db/queries/desire-paths';
import { mintCollectionSlug } from '@/lib/collections/slug';
import { assembleRoutes, routeSignature } from '@/lib/desire/assemble';
import { buildRouteNamePrompt, type RouteStop } from '@/lib/desire/caption';

// desire.promote: assemble the worn edges in path_traffic into corridors and
// file the ones above a strength floor as first-class desire_paths. Routes that
// were promoted before but have since decayed below the floor are retired
// (hidden, never deleted). Newly-filed routes get a human slug and a best-effort
// clerk-authored name; refreshed routes keep theirs.
//
// Idempotent per run by construction: existing corridors upsert by edge_sig,
// and retirement targets exactly the actives not re-promoted this pass.

type Payload = {
  // Minimum chain strength (weakest-link decayed traffic) to file a route.
  promoteFloor?: number;
  // Minimum per-edge decayed value to be eligible for a chain.
  minEdgeValue?: number;
  // Safety cap on how many routes to file in one run.
  maxRoutes?: number;
};

const DEFAULT_PROMOTE_FLOOR = 2; // ~two confirmed traversals of the weakest link
const DEFAULT_MIN_EDGE_VALUE = 1;
const DEFAULT_MAX_ROUTES = 100;
const TOP_EDGE_LIMIT = 2000;
const SLUG_RETRIES = 5;

export async function desirePromoteHandler(job: Job): Promise<void> {
  const payload = (job.payload ?? {}) as Payload;
  const promoteFloor = payload.promoteFloor ?? DEFAULT_PROMOTE_FLOOR;
  const minEdgeValue = payload.minEdgeValue ?? DEFAULT_MIN_EDGE_VALUE;
  const maxRoutes = payload.maxRoutes ?? DEFAULT_MAX_ROUTES;

  const edges = await getTopPaths(TOP_EDGE_LIMIT);
  // Assemble at the promotion floor, not the (looser) minEdgeValue. Strength is
  // a chain's weakest edge, so any edge below promoteFloor would drag its whole
  // corridor below the floor -- and, because assembly is greedy, a weak edge can
  // get appended to a genuinely hot corridor and sink it (e.g. a qualifying
  // 1->2->3 discarded because a weak 3->4 was greedily tacked on). Extending
  // only through >= floor edges keeps qualifying corridors intact; the post
  // filter then only trims sub-minNodes remnants.
  const assemblyFloor = Math.max(minEdgeValue, promoteFloor);
  const qualifying = assembleRoutes(edges, { minEdgeValue: assemblyFloor }).filter(
    (r) => r.strength >= promoteFloor
  );
  // Every corridor still above the floor stays alive: retirement targets only
  // actives absent from keepSigs, and the filing cap must not retire routes
  // that still qualify. So keepSigs is built from all qualifying corridors.
  const keepSigs = qualifying.map((r) => routeSignature(r.nodeIds));

  // Resolve a text-capable provider once (best-effort; captions degrade to null
  // when no key is configured or the provider has no raw-text method).
  const cfg = await loadAiConfig();
  const keys = await loadUserProviderKeys(getSiteAdminId());
  const provider = getProvider('descriptions', cfg, keys);
  const canCaption = typeof provider?.text === 'function';

  const now = new Date();
  let promoted = 0;
  let refreshed = 0;

  // Pass 1: refresh every existing qualifying corridor. Refresh is a cheap
  // UPDATE, so it is NOT subject to the filing cap -- capping it would freeze
  // strength/lifetime for routes beyond the cap while /paths keeps ordering by
  // the now-stale values. Collect the NEW corridors that still need filing.
  const toFile: typeof qualifying = [];
  for (const route of qualifying) {
    const sig = routeSignature(route.nodeIds);
    const existing = await getDesirePathBySig(sig);
    if (existing) {
      await refreshDesirePath(sig, {
        strength: route.strength,
        lifetime: route.lifetime,
        lastWalkedAt: now
      });
      refreshed++;
    } else if (toFile.length < maxRoutes) {
      toFile.push(route);
    }
  }

  // Filing a new corridor is the expensive part (slug + best-effort clerk
  // caption), so only that is bounded by maxRoutes. Batch-hydrate lead captions
  // for exactly the routes we will file, in one query, then slice per-route --
  // avoids an N+1 fetch across the filed set.
  const capMap: Map<number, CaptionSnippet> =
    canCaption && toFile.length > 0
      ? await firstCaptionsByImageIds([...new Set(toFile.flatMap((r) => r.nodeIds))])
      : new Map();

  for (const route of toFile) {
    const sig = routeSignature(route.nodeIds);

    // New corridor: name it (best-effort) and mint a slug, retrying on the rare
    // slug collision. An edge_sig collision here would mean a concurrent insert
    // of the same route; we swallow and move on (the other run filed it).
    let caption: string | null = null;
    let capProvider: string | null = null;
    let capModel: string | null = null;
    if (canCaption) {
      try {
        const stops: RouteStop[] = route.nodeIds.map((id) => {
          const c = capMap.get(id);
          return { slug: c?.slug ?? String(id), caption: c?.caption ?? '' };
        });
        const text = (await provider!.text!(buildRouteNamePrompt(stops))).trim();
        if (text) {
          caption = text;
          capProvider = cfg.descriptions.provider;
          capModel = cfg.descriptions.model;
        }
      } catch {
        // best-effort: leave the route unnamed; a later run can fill it.
      }
    }

    let filed = false;
    for (let attempt = 0; attempt < SLUG_RETRIES && !filed; attempt++) {
      try {
        await insertDesirePath({
          slug: mintCollectionSlug(),
          edgeSig: sig,
          nodeIds: route.nodeIds,
          caption,
          provider: capProvider,
          model: capModel,
          strength: route.strength,
          lifetime: route.lifetime,
          lastWalkedAt: now
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

  const retired = await retireDesirePathsExcept(keepSigs, now);
  console.log(
    `desire.promote: ${promoted} promoted, ${refreshed} refreshed, ${retired} retired ` +
      `(from ${edges.length} worn edges, ${qualifying.length} corridors above floor ${promoteFloor}, ` +
      `${toFile.length} newly filed this run)`
  );
}
