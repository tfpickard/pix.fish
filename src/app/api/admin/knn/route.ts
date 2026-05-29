import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import { enqueueJob } from '@/lib/db/queries/jobs';
import { countKnnEdges } from '@/lib/db/queries/knn';
import { KNN_K } from '@/lib/knn';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET: current graph stats (edge count, default k). Used by the admin UI
// to show whether the graph has been built and how many edges it has.
export async function GET() {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const edgeCount = await countKnnEdges();
  return NextResponse.json({ edgeCount, defaultK: KNN_K });
}

// POST: enqueue a knn.rebuild job. Optional body: { k: number } to override
// the default k value (useful for experimentation without a redeploy).
export async function POST(req: Request) {
  if (!isSiteAdmin(await auth())) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let k: number | undefined;
  try {
    const body = await req.json();
    if (body?.k !== undefined) {
      // Reject fractional or sub-1 values -- Math.trunc(0.5) = 0 would clear
      // the graph with no edges, leaving /connect unusable.
      const raw = body.k;
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
        return NextResponse.json(
          { error: 'k must be a positive integer >= 1' },
          { status: 400 }
        );
      }
      k = raw;
    }
  } catch {
    // No body or non-JSON body is fine; use the default k.
  }

  const job = await enqueueJob({
    type: 'knn.rebuild',
    payload: k !== undefined ? { k } : {},
    maxAttempts: 2
  });

  return NextResponse.json({ jobId: job.id, k: k ?? KNN_K });
}
