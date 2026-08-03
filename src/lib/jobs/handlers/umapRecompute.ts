import { UMAP } from 'umap-js';
import type { Job } from '@/lib/db/schema';
import { allCaptionVectors } from '@/lib/db/queries/embeddings';
import { latestProjection, saveProjection } from '@/lib/db/queries/umap';

type Payload = { nNeighbors?: number; minDist?: number; kind?: string };

// umap-js is pure JS; above this threshold we subsample deterministically so
// the job stays inside the 60s Vercel function budget. Revisit if the gallery
// grows past this point.
const MAX_POINTS = 5000;

// Fixed seed for the UMAP optimization itself. Without a `random` source
// umap-js seeds from Math.random, so two runs over the SAME vectors can land
// on arbitrarily rotated or reflected layouts. That was tolerable while the
// only trigger was an admin clicking recompute; now that every embedding write
// schedules one, an unseeded projection would visibly scramble /map on each
// upload and destroy any sense of a stable place. manifoldRecompute passes a
// seeded RNG for exactly this reason.
const UMAP_SEED = 42;

/**
 * Resolve the projection parameters for this run.
 *
 * Anything the payload states explicitly wins -- that is the admin asking for
 * a specific projection through /api/admin/umap/recompute. Anything it omits
 * is inherited from whatever projection is currently live, because an
 * automatic refresh means "the same atlas over newer data", not "reset the
 * atlas to defaults".
 *
 * Resolved HERE, at execution time, rather than when the job is enqueued. The
 * automatic job is deliberately delayed by a couple of minutes to collapse
 * upload bursts, and an admin can queue a tuned recompute inside that window.
 * Reading the params at enqueue time meant the delayed job would land after
 * the manual one carrying pre-tuning values and silently revert it.
 */
type LiveParams = { nNeighbors?: unknown; minDist?: unknown; kind?: unknown };

/**
 * True if it is still safe for this run to become the newest projection.
 *
 * Only meaningful for a run that INHERITED its parameters. Execution-time
 * inheritance closes the pending-job case, but not the overlapping-execution
 * one: the worker allows concurrent drains, so an automatic run can read the
 * live params, spend up to a minute inside umap.fit(), and only then save --
 * by which time an admin's tuned recompute may have started later and finished
 * first. Saving then would silently revert them with a snapshot taken before
 * they existed.
 *
 * So re-read immediately before saving and stand down if the live
 * configuration is no longer the one we inherited. Dropping this run's work is
 * the right trade: the projection that replaced it is both newer and correctly
 * configured, and the next embedding write schedules another refresh anyway.
 *
 * A run with explicit payload params is the admin, and always saves.
 */
async function stillCurrent(resolved: Required<Payload>, inherited: boolean): Promise<boolean> {
  if (!inherited) return true;
  const live = ((await latestProjection())?.params ?? null) as LiveParams | null;
  if (!live) return true;
  return (
    live.nNeighbors === resolved.nNeighbors &&
    live.minDist === resolved.minDist &&
    live.kind === resolved.kind
  );
}

async function resolveParams(payload: Payload): Promise<Required<Payload>> {
  const needsInheritance =
    payload.nNeighbors === undefined || payload.minDist === undefined || payload.kind === undefined;

  // Deliberately NOT wrapped in a try. "No projection exists yet" and "the
  // projection could not be read" look identical downstream but mean opposite
  // things: the first is a first run and defaults are right, the second is a
  // transient failure where defaults would overwrite an admin's tuned atlas
  // AND mark the job done, spending none of the three attempts that exist for
  // exactly this. latestProjection() already returns null for the empty case,
  // so anything it throws is the second case -- let it reach the retry loop.
  const live = needsInheritance
    ? (((await latestProjection())?.params ?? null) as LiveParams | null)
    : null;

  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

  return {
    nNeighbors: payload.nNeighbors ?? num(live?.nNeighbors) ?? 15,
    minDist: payload.minDist ?? num(live?.minDist) ?? 0.1,
    kind: payload.kind ?? str(live?.kind) ?? 'caption'
  };
}

// Simple mulberry32 PRNG. Seeded by point count so a given run is
// reproducible: re-triggering without new uploads yields the same subsample.
function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export async function umapRecomputeHandler(job: Job): Promise<void> {
  const payload = job.payload as Payload;
  const resolved = await resolveParams(payload);
  const { nNeighbors, minDist, kind } = resolved;
  // An automatic refresh inherits; an admin request states its own.
  const inherited =
    payload.nNeighbors === undefined && payload.minDist === undefined && payload.kind === undefined;

  const all = await allCaptionVectors();
  if (all.length < 4) {
    // UMAP needs at least nNeighbors+1 points to be meaningful. Persist an
    // empty projection so the read path knows the job ran.
    await saveProjection({ nNeighbors, minDist, kind }, []);
    return;
  }

  // Subsample if needed. Deterministic Fisher-Yates shuffle over the index
  // array, then take the first MAX_POINTS. Avoid `sort(() => rnd() - 0.5)`
  // which is biased (non-transitive comparator) and non-deterministic across
  // sort implementations.
  let sample = all;
  if (all.length > MAX_POINTS) {
    const rnd = mulberry32(all.length);
    const indices = all.map((_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const tmp = indices[i]!;
      indices[i] = indices[j]!;
      indices[j] = tmp;
    }
    sample = indices.slice(0, MAX_POINTS).map((i) => all[i]!);
  }

  const nbrs = Math.min(nNeighbors, sample.length - 1);
  const umap = new UMAP({
    nComponents: 2,
    nNeighbors: nbrs,
    minDist,
    // Seeded so repeated runs over the same corpus produce the same layout.
    random: mulberry32(UMAP_SEED)
  });
  const coords = umap.fit(sample.map((s) => s.vec));

  const points = sample.map((s, i) => ({
    imageId: s.imageId,
    x: coords[i]![0]!,
    y: coords[i]![1]!
  }));

  // Checked here rather than before the fit: the whole point is that the fit
  // is slow enough for the configuration to change underneath it.
  if (!(await stillCurrent(resolved, inherited))) {
    console.warn('umap: live params changed during fit, discarding this run rather than reverting them');
    return;
  }

  await saveProjection({ nNeighbors, minDist, kind }, points);
}
