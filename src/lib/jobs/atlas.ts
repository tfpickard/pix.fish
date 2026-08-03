import { enqueueJob, hasPendingJobOfType } from '@/lib/db/queries/jobs';
import { latestProjection } from '@/lib/db/queries/umap';

// Debounce window for the atlas refresh fired after a new caption vector lands.
// Long enough that an upload flurry (or a backfill run) collapses to ~one
// projection via the pending-dedupe below, short enough that a single new
// upload appears on /map within a couple of minutes. Mirrors the recluster
// debounce in charactersDetect, which solves the same burst problem.
const UMAP_DEBOUNCE_MS = 120_000;

/**
 * Ask for a UMAP recompute because a caption vector changed.
 *
 * Call this from EVERY path that writes a caption embedding, not just the
 * upload path. The projection is built from those vectors, so a writer that
 * skips this leaves /map showing coordinates derived from a vector that no
 * longer exists -- reprocessing an image was doing exactly that, and the
 * backfill script could add hundreds of vectors without the atlas moving at
 * all. Three call sites today: persistEnrichment, the reprocess handler, and
 * scripts/backfill-embeddings.ts.
 *
 * Pending-only dedupe (not in-flight): a queued run has not read the vectors
 * yet, so it will include this change and we can skip. A run that is already
 * PROCESSING may have snapshotted before this write, so we still schedule one
 * -- otherwise a vector that raced a recompute would sit outside the atlas
 * until some later upload happened to trigger another.
 *
 * Best-effort by construction: never throws, so a failed enqueue cannot fail
 * the enrichment or reprocess that called it (compute-entropy.ts and the
 * /admin/map button both self-heal).
 */
export async function scheduleAtlasRefresh(): Promise<void> {
  try {
    if (await hasPendingJobOfType('umap.recompute')) return;
    await enqueueJob({
      type: 'umap.recompute',
      payload: await inheritedParams(),
      runAt: new Date(Date.now() + UMAP_DEBOUNCE_MS),
      // Not 1. This is the self-healing path: nothing re-triggers it, because
      // the embedding write that asked for it has already happened. A single
      // transient DB error or one brush with the handler's wall budget would
      // otherwise strand the atlas until the next upload or a manual
      // /admin/map click -- which is the staleness this whole file exists to
      // fix. Recompute is idempotent (it inserts a fresh projection row), so
      // retrying is safe.
      maxAttempts: 3
    });
  } catch (err) {
    console.error('failed to enqueue umap.recompute', err);
  }
}

/**
 * Carry the current projection's UMAP parameters into the automatic job.
 *
 * An empty payload is NOT equivalent to "whatever is live": umapRecompute
 * falls back to nNeighbors 15 / minDist 0.1, and latestProjection() hands
 * /map, /drift and universe/coords.ts the newest row regardless of params.
 * So an admin who tuned the atlas through /admin/map would have had it
 * silently reset to defaults by the next upload -- a refresh quietly becoming
 * a reconfiguration.
 *
 * Refreshing means the same projection over newer data, so read back what is
 * live and reuse it. Falls back to an empty payload (handler defaults) when
 * there is no projection yet or the read fails.
 */
async function inheritedParams(): Promise<Record<string, unknown>> {
  try {
    const latest = await latestProjection();
    const params = latest?.params as
      | { nNeighbors?: unknown; minDist?: unknown; kind?: unknown }
      | null
      | undefined;
    if (!params) return {};
    const payload: Record<string, unknown> = {};
    if (typeof params.nNeighbors === 'number') payload.nNeighbors = params.nNeighbors;
    if (typeof params.minDist === 'number') payload.minDist = params.minDist;
    if (typeof params.kind === 'string') payload.kind = params.kind;
    return payload;
  } catch (err) {
    console.error('could not read live umap params, falling back to defaults', err);
    return {};
  }
}
