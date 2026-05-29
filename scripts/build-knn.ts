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

  const start = Date.now();
  let lastLog = Date.now();

  if (dryRun) {
    // Run the full O(n^2) graph computation so the distance/sort/dedup logic
    // is actually exercised, but stub out the DB write functions so nothing
    // is committed. This validates correctness of the build without touching
    // knn_edges.
    const { allCaptionVectors } = await import('../src/lib/db/queries/embeddings');
    const all = await allCaptionVectors();
    console.log(`dry-run: loaded ${all.length} embeddings`);

    // Re-implement the build loop here (mirroring buildKnnGraph internals) so
    // we can skip clearAllKnnEdges and insertKnnEdges while still exercising
    // cosineDist, sort, dedup, and the progress callback. We import the
    // internal helper via the parent module rather than duplicating it.
    //
    // To avoid duplicating the build logic, we call buildKnnGraph with stubbed
    // DB helpers by temporarily monkey-patching the queries module. Since bun
    // caches modules, we can mutate the export references safely in a script.
    const knnQueries = await import('../src/lib/db/queries/knn');
    const origClear = knnQueries.clearAllKnnEdges;
    const origInsert = knnQueries.insertKnnEdges;

    // Capture the edges that would be written so we can report the real count.
    let dryEdgeCount = 0;
    knnQueries.clearAllKnnEdges = async () => { /* no-op */ };
    knnQueries.insertKnnEdges = async (edges: { srcId: number; dstId: number; dist: number }[]) => { dryEdgeCount += edges.length; };

    try {
      const { nodeCount } = await buildKnnGraph({
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
      console.log(`dry-run done: nodes=${nodeCount}, edges=${dryEdgeCount} (directed), elapsed=${elapsed}s -- no DB writes`);
    } finally {
      knnQueries.clearAllKnnEdges = origClear;
      knnQueries.insertKnnEdges = origInsert;
    }
    return;
  }

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
