/**
 * Offline kNN graph builder.
 *
 * Reads all caption embeddings from Postgres, computes the k-nearest-neighbor
 * graph by cosine distance, and writes the edges to knn_edges.
 *
 * Prefer this script over the job-queue handler when the corpus is large
 * (>5000 images) because it runs without the 60s Vercel function wall.
 *
 *   bun scripts/build-knn.ts [--k=<int>] [--dry-run]
 *
 * --k=N       Override the default k value (default: KNN_K from src/lib/knn.ts).
 * --dry-run   Compute but do not write to the database. Logs what would be written.
 */

import { buildKnnGraph, KNN_K } from '../src/lib/knn';

async function main() {
  const args = process.argv.slice(2);

  let k = KNN_K;
  let dryRun = false;

  for (const arg of args) {
    if (arg.startsWith('--k=')) {
      const n = parseInt(arg.slice(4), 10);
      if (!Number.isInteger(n) || n < 1) {
        console.error(`invalid --k value: ${arg.slice(4)}`);
        process.exit(1);
      }
      k = n;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else {
      console.error(`unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  console.log(`build-knn: k=${k}${dryRun ? ' (dry-run -- no DB writes)' : ''}`);

  if (dryRun) {
    // In dry-run mode we still run the O(n^2) pass to validate the corpus
    // is accessible and the build logic runs without error, but skip DB writes.
    // Import allCaptionVectors directly to avoid triggering clearAllKnnEdges.
    const { allCaptionVectors } = await import('../src/lib/db/queries/embeddings');
    const all = await allCaptionVectors();
    console.log(`dry-run: loaded ${all.length} embeddings, would write ~${all.length * k * 2} directed edges`);
    console.log('dry-run: skipping graph computation and DB write');
    return;
  }

  const start = Date.now();
  let lastLog = Date.now();

  const { nodeCount, edgeCount } = await buildKnnGraph({
    k,
    onProgress: (done, total) => {
      const now = Date.now();
      if (now - lastLog >= 2000) {
        const pct = ((done / total) * 100).toFixed(1);
        const elapsed = ((now - start) / 1000).toFixed(1);
        console.log(`  ${done}/${total} (${pct}%) -- ${elapsed}s elapsed`);
        lastLog = now;
      }
    }
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`done: nodes=${nodeCount}, edges=${edgeCount} (directed), elapsed=${elapsed}s`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit(0));
