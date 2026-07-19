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
  const qualifying = assembleRoutes(edges, { minEdgeValue }).filter(
    (r) => r.strength >= promoteFloor
  );
  // Every corridor still above the floor stays alive, including the ones the
  // filing cap skips this run: maxRoutes bounds how many we insert/refresh per
  // pass, it must NOT retire routes that still qualify. So keepSigs is built
  // from all qualifying corridors, but only `toProcess` does insert/refresh work.
  const keepSigs = qualifying.map((r) => routeSignature(r.nodeIds));
  const toProcess = qualifying.slice(0, maxRoutes);

  // Resolve a text-capable provider once (best-effort; captions degrade to null
  // when no key is configured or the provider has no raw-text method).
  const cfg = await loadAiConfig();
  const keys = await loadUserProviderKeys(getSiteAdminId());
  const provider = getProvider('descriptions', cfg, keys);
  const canCaption = typeof provider?.text === 'function';

  // Batch-hydrate lead captions for every processed corridor's stops in one
  // query (the union of all node ids), then slice per-route below. Avoids an
  // N+1 fetch of two queries per route across up to maxRoutes corridors. Only
  // worth doing when we can actually name routes.
  const capMap: Map<number, CaptionSnippet> = canCaption
    ? await firstCaptionsByImageIds([...new Set(toProcess.flatMap((r) => r.nodeIds))])
    : new Map();

  const now = new Date();
  let promoted = 0;
  let refreshed = 0;

  for (const route of toProcess) {
    const sig = routeSignature(route.nodeIds);

    const existing = await getDesirePathBySig(sig);
    if (existing) {
      await refreshDesirePath(sig, {
        strength: route.strength,
        lifetime: route.lifetime,
        lastWalkedAt: now
      });
      refreshed++;
      continue;
    }

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
      `${toProcess.length} processed this run)`
  );
}
