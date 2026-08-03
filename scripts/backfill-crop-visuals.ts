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
import {
  abandonedImageVecSample,
  countCropsAbandonedImageVec,
  MAX_IMAGE_EMBED_ATTEMPTS
} from '../src/lib/db/queries/character-crops';
import { backfillVisualsInline } from '../src/lib/universe/backfill-visuals';

async function main() {
  const embedder = getImageEmbedder();
  if (!embedder) {
    console.error('no VOYAGE_API_KEY set -- cannot compute visual embeddings.');
    process.exit(1);
  }

  console.log(`backfilling visual vectors via ${embedder.model}...`);
  // Loops until every crop missing a vec_image is embedded (one page-load caps
  // at the query LIMIT, so a large backlog needs the loop).
  const { ok, fail } = await backfillVisualsInline(embedder, (m) => console.log(m));
  console.log(`done: ${ok} embedded, ${fail} failed.`);

  // Crops past the attempt cap are skipped by the sweep, so "0 failed" alone
  // would read as full coverage while a visual/blend cluster stays blocked.
  // Name them, with a sample to open.
  const abandoned = await countCropsAbandonedImageVec();
  if (abandoned > 0) {
    console.warn(
      `\n${abandoned} crop(s) failed ${MAX_IMAGE_EMBED_ATTEMPTS} times and are no longer retried -- ` +
        `visual/blend clustering stays blocked until they are resolved.`
    );
    for (const c of await abandonedImageVecSample(5)) {
      console.warn(`  crop ${c.cropId} (image ${c.imageId}) ${c.blobUrl}`);
    }
    console.warn(
      `Force re-detect those images to re-cut the crops, or release the cap from /admin/characters ` +
        `once the underlying cause is fixed.`
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit(0));
