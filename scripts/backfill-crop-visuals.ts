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
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit(0));
