import { getEmbedder, getProvider, loadUserProviderKeys, type AITag } from '@/lib/ai';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { parseTagsJson, parseVariantsJson } from '@/lib/ai/types';
import { getCaptionVector, searchByVector } from '@/lib/db/queries/embeddings';
import { getImagesByIdsOrdered, hydrateImages } from '@/lib/db/queries/images';
import type { ImageWithRelations } from '@/lib/db/queries/images';
import { resolvePrompt } from '@/lib/prompts';

const EMBED_DIMENSIONS = 1536;
const AVOID_LIST_SIZE = 6;
const CENTROID_SEARCH_OVERSHOOT = 10;
const OUTPUT_NEIGHBORS = 12;
const OUTPUT_NEIGHBORS_OVERSHOOT = 24;

export type BreedVariants = {
  variant1: string;
  variant2: string;
  variant3: string;
};

export type BreedResult = {
  variants: BreedVariants;
  tags: AITag[];
  newEmbedding: number[] | null;
  // Ids of the new description's nearest existing images. Includes neither
  // the source images nor the centroid avoid-list (they were the prompt
  // inputs; surfacing them again as "where the phantom lives" is misleading).
  neighborImageIds: number[];
  // The avoid-list we showed the LLM. Returned so the API/UI can surface
  // "we told the model not to look like these" for transparency.
  centroidNeighborImageIds: number[];
  // Provenance: what model/provider authored the text + the embedding. Lets
  // the future phantom_images table record the same per-row stamps every
  // other AI-touched row in this schema carries.
  textProvider: string;
  textModel: string;
  embedProvider: string | null;
  embedModel: string | null;
};

export class BreedError extends Error {
  readonly code: 'no_source_embeddings' | 'no_text_provider' | 'llm_failed';
  constructor(code: BreedError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Generate a "spiritual successor" description by blending the caption
 * embeddings of N selected images and prompting the LLM with both the
 * sources and the existing images closest to their centroid (as an
 * anti-prompt). Returns plain data; persistence is the caller's choice.
 */
export async function breedFromImageIds(opts: {
  sourceImageIds: number[];
  userId: string;
}): Promise<BreedResult> {
  const sourceIds = [...new Set(opts.sourceImageIds)];

  const cfg = await loadAiConfig();
  const keys = await loadUserProviderKeys(opts.userId);

  // Hydrate sources first so we can format prompt context even for images
  // that have no embedding yet (still useful for the LLM, just won't
  // contribute to the centroid).
  const sourceRows = await getImagesByIdsOrdered(sourceIds);
  const sourceHydrated = await hydrateImages(sourceRows);

  // Pull every source vector in parallel. Skip null returns; the centroid
  // is computed only over images that actually contributed.
  const vecResults = await Promise.all(sourceIds.map((id) => getCaptionVector(id)));
  const sourceVectors = vecResults.filter((v): v is number[] => Array.isArray(v));
  if (sourceVectors.length < 2) {
    throw new BreedError(
      'no_source_embeddings',
      `need >=2 source images with caption embeddings; got ${sourceVectors.length}.`
    );
  }

  const centroid = meanVector(sourceVectors);

  // Overshoot so we still have N after filtering out the source ids. The
  // search uses pgvector; cheap to ask for a few extra.
  const rawCentroidMatches = await searchByVector(centroid, {
    limit: AVOID_LIST_SIZE + CENTROID_SEARCH_OVERSHOOT,
    kind: 'caption'
  });
  const sourceSet = new Set(sourceIds);
  const centroidNeighborIds = rawCentroidMatches
    .map((m) => m.imageId)
    .filter((id) => !sourceSet.has(id))
    .slice(0, AVOID_LIST_SIZE);
  const centroidNeighborRows = await getImagesByIdsOrdered(centroidNeighborIds);
  const centroidNeighborsHydrated = await hydrateImages(centroidNeighborRows);

  const sourceCaptions = formatImagesForPrompt(sourceHydrated);
  const neighborCaptions = formatImagesForPrompt(centroidNeighborsHydrated);

  const prompt = await resolvePrompt('breed', {
    source_captions: sourceCaptions,
    neighbor_captions: neighborCaptions,
    n_sources: sourceVectors.length
  });

  // The text-completion path lives behind the descriptions field's provider
  // routing. That field's model already writes long-form variant text;
  // reusing the routing avoids a third ai_config column for what is, in
  // Phase 1, a one-off generator.
  const provider = getProvider('descriptions', cfg, keys);
  if (!provider || !provider.text) {
    throw new BreedError(
      'no_text_provider',
      'descriptions provider is not configured for the current user, or does not support text-only generation.'
    );
  }

  let raw: string;
  try {
    raw = await provider.text(prompt);
  } catch (err) {
    console.error('breed: provider.text failed', err);
    throw new BreedError('llm_failed', 'LLM call failed.');
  }

  const variantArr = parseVariantsJson(raw);
  const variants: BreedVariants = {
    variant1: variantArr[0] ?? '',
    variant2: variantArr[1] ?? '',
    variant3: variantArr[2] ?? ''
  };
  const tagParse = parseTagsJson(raw);

  // Embed the new description (literal caption + paragraph) so we can show
  // the user where this idea lives in their library. Best-effort: a failed
  // embedding does not fail the breed call, mirroring how upload's
  // embedding step is best-effort in src/app/api/images/route.ts.
  let newEmbedding: number[] | null = null;
  let embedProvider: string | null = null;
  let embedModel: string | null = null;
  const embedder = getEmbedder(cfg, keys);
  if (embedder) {
    const embedInput = [variants.variant1, variants.variant3].filter(Boolean).join(' ').trim();
    if (embedInput) {
      try {
        const vec = await embedder.embed(embedInput);
        if (Array.isArray(vec) && vec.length === EMBED_DIMENSIONS) {
          newEmbedding = vec;
          embedProvider = embedder.name;
          embedModel = embedder.model;
        } else {
          console.error('breed: embedder returned wrong-shape vector', {
            len: Array.isArray(vec) ? vec.length : typeof vec
          });
        }
      } catch (err) {
        console.error('breed: embedding new description failed', err);
      }
    }
  }

  let neighborImageIds: number[] = [];
  if (newEmbedding) {
    const rawNeighbors = await searchByVector(newEmbedding, {
      limit: OUTPUT_NEIGHBORS + OUTPUT_NEIGHBORS_OVERSHOOT,
      kind: 'caption'
    });
    neighborImageIds = rawNeighbors
      .map((m) => m.imageId)
      .filter((id) => !sourceSet.has(id))
      .slice(0, OUTPUT_NEIGHBORS);
  }

  return {
    variants,
    tags: tagParse.tags,
    newEmbedding,
    neighborImageIds,
    centroidNeighborImageIds: centroidNeighborIds,
    textProvider: provider.name,
    textModel: provider.model,
    embedProvider,
    embedModel
  };
}

function meanVector(vectors: number[][]): number[] {
  const dim = vectors[0]!.length;
  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    if (v.length !== dim) {
      throw new Error(`embedding length mismatch: ${v.length} vs ${dim}.`);
    }
    for (let i = 0; i < dim; i++) sum[i] += v[i]!;
  }
  const n = vectors.length;
  for (let i = 0; i < dim; i++) sum[i] = sum[i]! / n;
  return sum;
}

// Serialise a hydrated image into a compact line the LLM can reason over.
// We deliberately drop ids, slugs, and provenance: the model only needs the
// semantic content, and trimming this keeps the prompt small.
function formatImagesForPrompt(images: ImageWithRelations[]): string {
  if (images.length === 0) return '(none)';
  return images
    .map((img, idx) => {
      const caps = img.captions
        .slice(0, 3)
        .map((c) => c.text)
        .filter(Boolean);
      const descs = img.descriptions
        .slice(0, 3)
        .map((d) => d.text)
        .filter(Boolean);
      const tagList = img.tags.map((t) => t.tag).slice(0, 12);
      const parts: string[] = [];
      if (caps.length > 0) parts.push(`captions: ${caps.join(' | ')}`);
      if (descs.length > 0) parts.push(`descriptions: ${descs.join(' | ')}`);
      if (tagList.length > 0) parts.push(`tags: ${tagList.join(', ')}`);
      return `[${idx + 1}] ${parts.join('\n    ')}`;
    })
    .join('\n');
}
