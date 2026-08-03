import { enqueueJob, hasPendingJobOfType } from '@/lib/db/queries/jobs';

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
      payload: {},
      runAt: new Date(Date.now() + UMAP_DEBOUNCE_MS),
      maxAttempts: 1
    });
  } catch (err) {
    console.error('failed to enqueue umap.recompute', err);
  }
}
