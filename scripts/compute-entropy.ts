/**
 * Offline entropy pass for feat/hud.
 *
 * Computes a per-image surprisal score (writes images.surprisal) and a single
 * collection-temperature scalar (inserts one collection_temperature row so the
 * dispersion history accrues). The math lives in src/lib/entropy.ts and is
 * shared with the entropy.recompute job handler -- this script is just the
 * batch entry point, mirroring scripts/backfill-embeddings.ts wiring.
 *
 * Surprisal blends two normalized components (see src/lib/entropy.ts):
 *   A) cosine distance from the corpus centroid of caption embeddings
 *   B) tag rarity = sum over the image's tags of -log(p(tag))
 * Both are min-max normalized across the corpus before blending (weight
 * W_CENTROID) so neither dominates. The result is fully deterministic.
 *
 *   bun scripts/compute-entropy.ts
 *
 * Safe to run repeatedly. Needs the same env as backfill-embeddings.ts
 * (POSTGRES_URL). It does NOT call any model -- it reads existing embeddings
 * and tags, so it never spends API credit.
 */
import { recomputeEntropy } from '../src/lib/entropy';

async function main() {
  if (!process.env.POSTGRES_URL) {
    console.error('POSTGRES_URL not set. Aborting.');
    process.exit(1);
  }

  console.log('computing entropy over the caption-embedding corpus...');
  const result = await recomputeEntropy();

  if (result.pointCount === 0) {
    console.log('no caption embeddings found -- nothing to score. run backfill-embeddings.ts first.');
    return;
  }

  console.log(`scored ${result.surprisalWritten} image(s)`);
  console.log(
    `collection temperature: ${result.temperature.toFixed(4)} ` +
      `(mean pairwise cosine distance over ${result.pointCount} points` +
      `${result.sampledPairs !== null ? `, sampled ${result.sampledPairs} pairs` : ', exact'})`
  );
  console.log(`mean centroid distance: ${result.meanCentroidDistance.toFixed(4)}`);
  if (result.previousTemperature !== null) {
    const delta = result.temperature - result.previousTemperature;
    console.log(
      `temperature delta vs previous run: ${delta >= 0 ? '+' : ''}${delta.toFixed(4)} ` +
        `(was ${result.previousTemperature.toFixed(4)})`
    );
  } else {
    console.log('temperature delta: n/a (first recorded run)');
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit(0));
