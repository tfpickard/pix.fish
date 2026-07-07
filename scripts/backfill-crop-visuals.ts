/**
 * Backfill visual identity embeddings (Voyage multimodal) for character crops
 * that don't have one yet -- crops detected before this feature, or detected
 * while VOYAGE_API_KEY was unset. Idempotent: only touches crops with a null
 * vec_image. Safe to re-run.
 *
 *   VOYAGE_API_KEY=... bun run characters:backfill-visuals
 *
 * After backfilling, switch the clustering "identity space" to visual or blend
 * on /admin/characters (or --space via characters:detect) and re-cluster.
 */
import { getImageEmbedder } from '../src/lib/ai/imageEmbed';
import { cropsMissingImageVec, setCropImageVec } from '../src/lib/db/queries/character-crops';

async function main() {
  const embedder = getImageEmbedder();
  if (!embedder) {
    console.error('no VOYAGE_API_KEY set -- cannot compute visual embeddings.');
    process.exit(1);
  }

  const crops = await cropsMissingImageVec();
  console.log(`backfilling visual vectors for ${crops.length} crop(s) via ${embedder.model}`);
  let ok = 0;
  let fail = 0;
  for (const crop of crops) {
    try {
      const vec = await embedder.embed(crop.blobUrl);
      await setCropImageVec(crop.cropId, vec, embedder.name, embedder.model);
      ok++;
      if (ok % 20 === 0) console.log(`  ${ok}/${crops.length}`);
    } catch (err) {
      fail++;
      console.error(`  crop ${crop.cropId} failed:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`done: ${ok} embedded, ${fail} failed.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit(0));
