import type { Job } from '@/lib/db/schema';
import { buildKnnGraph, KNN_K } from '@/lib/knn';

type Payload = { k?: number };

// Job handler for 'knn.rebuild'. Builds the k-nearest-neighbor graph over
// all caption embeddings and persists it to knn_edges.
//
// The job is enqueued from /api/admin/knn/rebuild (admin-only route).
// Monitor at /admin/jobs. Rebuild is idempotent: existing edges are cleared
// before writing so stale rows from removed images never accumulate.
//
// Heavy corpus note: buildKnnGraph() is O(n^2 * d). At 5000 images the
// in-memory pass takes ~10-20 seconds, within the 50s budget here. If the
// corpus grows beyond ~10000 images this job should be moved to an offline
// bun script (scripts/build-knn.ts) rather than running in the Vercel
// function environment.
export async function knnRebuildHandler(job: Job): Promise<void> {
  const payload = (job.payload ?? {}) as Payload;
  const k = payload.k ?? KNN_K;

  let lastLog = Date.now();
  const { nodeCount, edgeCount } = await buildKnnGraph({
    k,
    onProgress: (done, total) => {
      // Throttle progress logging to once per 5 seconds so we don't spam
      // the Vercel function log for large corpora.
      const now = Date.now();
      if (now - lastLog >= 5000) {
        console.log(`knn.rebuild: ${done}/${total} nodes processed`);
        lastLog = now;
      }
    }
  });

  console.log(
    `knn.rebuild done: k=${k}, nodes=${nodeCount}, edges=${edgeCount} (directed, both-direction)`
  );
}
