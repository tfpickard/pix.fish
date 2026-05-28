import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth, isSiteAdmin } from '@/lib/auth';
import { BreedError, breedFromImageIds, type BreedMode } from '@/lib/ai/breed';
import { getImagesByIdsOrdered, hydrateImages } from '@/lib/db/queries/images';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MODES = ['breed', 'depart', 'antibreed', 'subtract'] as const;

const bodySchema = z.object({
  mode: z.enum(MODES),
  // breed/depart/antibreed: 2..8 sources. subtract: anchor + 1..7 subtracts,
  // i.e. still 2..8 total. Same outer bounds so the request validator stays
  // simple; subtract-specific shape is enforced by the prep step which
  // treats the first id as the anchor.
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
  const mode: BreedMode = parsed.data.mode;
  // Dedupe but preserve order -- subtract relies on imageIds[0] being the
  // anchor. Set+spread would re-order.
  const seen = new Set<number>();
  const uniqueIds: number[] = [];
  for (const id of parsed.data.imageIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    uniqueIds.push(id);
  }
  if (uniqueIds.length < 2) {
    return NextResponse.json(
      { error: 'need at least 2 distinct imageIds' },
      { status: 400 }
    );
  }

  let result;
  try {
    result = await breedFromImageIds({ mode, imageIds: uniqueIds, userId });
  } catch (err) {
    if (err instanceof BreedError) {
      const status =
        err.code === 'no_source_embeddings' ||
        err.code === 'no_anchor_embedding' ||
        err.code === 'no_subtract_embeddings'
          ? 422
          : err.code === 'no_text_provider'
            ? 409
            : 502;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    console.error('breed: unexpected failure', err);
    return NextResponse.json({ error: 'breed failed' }, { status: 500 });
  }

  const [neighborRows, contextRows] = await Promise.all([
    getImagesByIdsOrdered(result.neighborImageIds),
    getImagesByIdsOrdered(result.contextNeighborImageIds)
  ]);
  const [neighbors, contextNeighbors] = await Promise.all([
    hydrateImages(neighborRows),
    hydrateImages(contextRows)
  ]);

  return NextResponse.json({
    mode: result.mode,
    variants: result.variants,
    tags: result.tags,
    neighbors,
    contextNeighbors,
    provenance: {
      textProvider: result.textProvider,
      textModel: result.textModel,
      embedProvider: result.embedProvider,
      embedModel: result.embedModel
    }
  });
}
