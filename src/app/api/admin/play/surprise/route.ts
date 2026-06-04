import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import { getGalleryCentroid } from '@/lib/playground/centroid';
import { searchByVector } from '@/lib/db/queries/embeddings';
import { getImagesByIdsOrdered, hydrateImages, listImages } from '@/lib/db/queries/images';
import { resolvePrompt } from '@/lib/prompts';
import { parseVariantsJson } from '@/lib/ai/types';
import { getPlaygroundTextRunner, formatCaptionsForPrompt } from '@/lib/playground/llm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FAR_REFERENCES = 8;
const MOTIF_SAMPLE = 30;

export async function GET() {
  const session = await auth();
  if (!isSiteAdmin(session) || !session?.user?.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const centroid = await getGalleryCentroid();
  if (!centroid) {
    return NextResponse.json(
      {
        prompts: [],
        warning: 'no caption embeddings yet -- the surprise engine needs an embedded corpus.'
      },
      { status: 200 }
    );
  }

  const runner = await getPlaygroundTextRunner();
  if (!runner) {
    return NextResponse.json(
      { prompts: [], warning: 'no text provider configured for the site admin.' },
      { status: 200 }
    );
  }

  // Far territory: existing images sitting farthest from the gallery centroid.
  // High-dimensional caveat aside (see embeddings.ts), these are only LLM
  // context, not a final answer, so incoherence is acceptable here.
  const farMatches = await searchByVector(centroid, {
    order: 'farthest',
    limit: FAR_REFERENCES,
    kind: 'caption',
    nsfwMode: 'include'
  });
  const farRows = await getImagesByIdsOrdered(farMatches.map((m) => m.imageId));
  const farHydrated = await hydrateImages(farRows);

  // Motif sample: a slice of the gallery's actual captions so the model can
  // infer recurring motifs to invert.
  const sampleImages = await listImages({ limit: MOTIF_SAMPLE, sort: 'newest', nsfwMode: 'include' });

  const prompt = await resolvePrompt('surprise', {
    far_neighbor_captions: formatCaptionsForPrompt(farHydrated),
    motif_sample: formatCaptionsForPrompt(sampleImages)
  });

  let raw: string;
  try {
    raw = await runner.run(prompt);
  } catch (err) {
    console.error('surprise generation failed', err);
    return NextResponse.json({ error: 'generation failed' }, { status: 502 });
  }

  const prompts = parseVariantsJson(raw).filter(Boolean);
  return NextResponse.json({ prompts });
}
