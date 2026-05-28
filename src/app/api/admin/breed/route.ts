import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth, isSiteAdmin } from '@/lib/auth';
import { BreedError, breedFromImageIds } from '@/lib/ai/breed';
import { getImagesByIdsOrdered, hydrateImages } from '@/lib/db/queries/images';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// One LLM call + one embedding call + a couple of vector searches. Mirror
// the upload route's headroom rather than the 10s default.
export const maxDuration = 60;

const bodySchema = z.object({
  imageIds: z.array(z.number().int().positive()).min(2).max(8)
});

export async function POST(req: Request) {
  const session = await auth();
  if (!isSiteAdmin(session)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const userId = session!.user!.id;
  if (!userId) {
    return NextResponse.json({ error: 'session missing user id' }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const uniqueIds = [...new Set(parsed.data.imageIds)];
  if (uniqueIds.length < 2) {
    return NextResponse.json(
      { error: 'need at least 2 distinct imageIds' },
      { status: 400 }
    );
  }

  let result;
  try {
    result = await breedFromImageIds({ sourceImageIds: uniqueIds, userId });
  } catch (err) {
    if (err instanceof BreedError) {
      // 422 for "you didn't give us enough material to work with"; 502 for
      // LLM/provider failure; 409 for missing provider config.
      const status =
        err.code === 'no_source_embeddings'
          ? 422
          : err.code === 'no_text_provider'
            ? 409
            : 502;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    console.error('breed: unexpected failure', err);
    return NextResponse.json({ error: 'breed failed' }, { status: 500 });
  }

  // Hydrate neighbor ids -> full image rows so the UI can render thumbnails
  // and captions without a second round-trip. Order is preserved by the
  // ordered-fetch helper.
  const [neighborRows, centroidNeighborRows] = await Promise.all([
    getImagesByIdsOrdered(result.neighborImageIds),
    getImagesByIdsOrdered(result.centroidNeighborImageIds)
  ]);
  const [neighbors, centroidNeighbors] = await Promise.all([
    hydrateImages(neighborRows),
    hydrateImages(centroidNeighborRows)
  ]);

  return NextResponse.json({
    variants: result.variants,
    tags: result.tags,
    neighbors,
    centroidNeighbors,
    provenance: {
      textProvider: result.textProvider,
      textModel: result.textModel,
      embedProvider: result.embedProvider,
      embedModel: result.embedModel
    }
  });
}
