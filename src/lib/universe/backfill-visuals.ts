import { type ImageEmbedder } from '@/lib/ai/imageEmbed';
import { cropsMissingImageVec, setCropImageVec } from '@/lib/db/queries/character-crops';

export type BackfillProgress = (msg: string) => void;

// Embed every character crop still missing a visual vector (Voyage multimodal),
// looping until the corpus is fully drained. Shared by the offline scripts:
// characters:backfill-visuals runs it standalone, and characters:detect drains
// it inline before a visual/blend cluster (detect only writes the text vec; the
// visual vec is filled out-of-band, so a local visual sweep must backfill first
// or produceCandidates finds every crop missing its vec_image and aborts).
//
// The queue's charactersBackfillVisualsHandler is the online counterpart -- it
// wall-budgets and re-enqueues instead of looping, since a cron tick can't run
// unbounded. This one loops because a script has no such budget.
//
// Idempotent: cropsMissingImageVec returns only NULL-vec rows, so each write
// shrinks the next page. We loop until a page comes back empty -- a single call
// caps at its LIMIT and would leave a large backlog unembedded.
export async function backfillVisualsInline(
  embedder: ImageEmbedder,
  onProgress?: BackfillProgress
): Promise<{ ok: number; fail: number }> {
  let ok = 0;
  let fail = 0;
  for (;;) {
    const crops = await cropsMissingImageVec();
    if (crops.length === 0) break;
    let progressed = 0;
    for (const crop of crops) {
      try {
        const vec = await embedder.embed(crop.blobUrl);
        await setCropImageVec(crop.cropId, vec, embedder.name, embedder.model);
        ok++;
        progressed++;
        if (ok % 20 === 0) onProgress?.(`  embedded ${ok}`);
      } catch (err) {
        fail++;
        onProgress?.(`  crop ${crop.cropId} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // A page where nothing succeeded is a persistent outage (or an all-poison
    // page): the same NULL rows would come back next fetch, so stop rather than
    // spin forever. Any rows that DID embed are gone from the next page, so a
    // mix of good + poison rows still converges to poison-only, then breaks.
    if (progressed === 0) break;
  }
  return { ok, fail };
}
