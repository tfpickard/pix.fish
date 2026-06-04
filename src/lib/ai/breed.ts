import { getEmbedder, getProvider, loadUserProviderKeys, type AITag } from '@/lib/ai';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { parseTagsJson, parseVariantsJson } from '@/lib/ai/types';
import { getCaptionVector, searchByVector } from '@/lib/db/queries/embeddings';
import { getImagesByIdsOrdered, hydrateImages } from '@/lib/db/queries/images';
import type { ImageWithRelations } from '@/lib/db/queries/images';
import { resolvePrompt } from '@/lib/prompts';
import type { PromptKey } from '@/lib/db/queries/prompts';
import { meanVector, subtractVector } from '@/lib/ai/vector';

const EMBED_DIMENSIONS = 1536;
const AVOID_LIST_SIZE = 6;
const SEARCH_OVERSHOOT = 10;
const OUTPUT_NEIGHBORS = 12;
const OUTPUT_NEIGHBORS_OVERSHOOT = 24;

export type BreedMode = 'breed' | 'depart' | 'antibreed' | 'subtract';

export type BreedVariants = {
  variant1: string;
  variant2: string;
  variant3: string;
};

export type BreedResult = {
  mode: BreedMode;
  variants: BreedVariants;
  tags: AITag[];
  newEmbedding: number[] | null;
  neighborImageIds: number[];
  // Mode-specific: for breed/depart/subtract these are the existing images
  // the LLM was told about (centroid neighbors / subtract neighborhood).
  // For antibreed these are the FAR-territory references the LLM was seeded
  // with.
  contextNeighborImageIds: number[];
  textProvider: string;
  textModel: string;
  embedProvider: string | null;
  embedModel: string | null;
};

export class BreedError extends Error {
  readonly code:
    | 'no_source_embeddings'
    | 'no_anchor_embedding'
    | 'no_subtract_embeddings'
    | 'no_text_provider'
    | 'llm_failed';
  constructor(code: BreedError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Generate a synthetic image description using one of four embedding-driven
 * strategies. For breed/depart/antibreed `imageIds` is the unordered set of
 * sources. For subtract the FIRST id is the anchor and the rest are the
 * images to subtract.
 *
 * Returns plain data. Persistence is the caller's choice.
 */
export async function breedFromImageIds(opts: {
  mode: BreedMode;
  imageIds: number[];
  userId: string;
}): Promise<BreedResult> {
  const { mode } = opts;
  const cfg = await loadAiConfig();
  const keys = await loadUserProviderKeys(opts.userId);

  // Build the seed vector and the prompt context. Each mode owns this step;
  // everything from "call the LLM" downward is shared.
  const seed =
    mode === 'subtract'
      ? await prepareSubtract(opts.imageIds)
      : await prepareCentroidMode(mode, opts.imageIds);

  const promptKey: PromptKey =
    mode === 'breed'
      ? 'breed'
      : mode === 'depart'
        ? 'depart'
        : mode === 'antibreed'
          ? 'antibreed'
          : 'subtract';

  const prompt = await resolvePrompt(promptKey, seed.promptContext);

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

  // Embed the new description and find its nearest existing images. Best
  // effort: a failed embed returns null + empty neighbors but doesn't fail
  // the call.
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
      kind: 'caption',
      nsfwMode: 'include'
    });
    neighborImageIds = rawNeighbors
      .map((m) => m.imageId)
      .filter((id) => !seed.excludeSet.has(id))
      .slice(0, OUTPUT_NEIGHBORS);
  }

  return {
    mode,
    variants,
    tags: tagParse.tags,
    newEmbedding,
    neighborImageIds,
    contextNeighborImageIds: seed.contextNeighborIds,
    textProvider: provider.name,
    textModel: provider.model,
    embedProvider,
    embedModel
  };
}

type SeedPrep = {
  // Ids to exclude from the output neighbor lookup (sources + any context
  // images we already showed the LLM and don't want to show again).
  excludeSet: Set<number>;
  // The ids of the existing images we showed the LLM as context, in order.
  contextNeighborIds: number[];
  // The placeholder map fed to resolvePrompt.
  promptContext: {
    source_captions?: string;
    neighbor_captions?: string;
    far_neighbor_captions?: string;
    anchor_caption?: string;
    subtract_captions?: string;
    n_sources?: number;
  };
};

// Shared prep for breed / depart / antibreed. All three centre on the
// centroid of the selected sources; only the *context-image lookup* and the
// prompt-key differ.
async function prepareCentroidMode(
  mode: Exclude<BreedMode, 'subtract'>,
  imageIds: number[]
): Promise<SeedPrep> {
  const sourceIds = [...new Set(imageIds)];
  const sourceRows = await getImagesByIdsOrdered(sourceIds);
  const sourceHydrated = await hydrateImages(sourceRows);

  const vecResults = await Promise.all(sourceIds.map((id) => getCaptionVector(id)));
  const sourceVectors = vecResults.filter((v): v is number[] => Array.isArray(v));
  if (sourceVectors.length < 2) {
    throw new BreedError(
      'no_source_embeddings',
      `need >=2 source images with caption embeddings; got ${sourceVectors.length}.`
    );
  }
  const centroid = meanVector(sourceVectors);

  const sourceSet = new Set(sourceIds);
  const rawMatches = await searchByVector(centroid, {
    limit: AVOID_LIST_SIZE + SEARCH_OVERSHOOT,
    kind: 'caption',
    order: mode === 'antibreed' ? 'farthest' : 'nearest',
    nsfwMode: 'include'
  });
  const contextNeighborIds = rawMatches
    .map((m) => m.imageId)
    .filter((id) => !sourceSet.has(id))
    .slice(0, AVOID_LIST_SIZE);
  const contextNeighborRows = await getImagesByIdsOrdered(contextNeighborIds);
  const contextNeighborsHydrated = await hydrateImages(contextNeighborRows);

  const sourceCaptions = formatImagesForPrompt(sourceHydrated);
  const neighborCaptions = formatImagesForPrompt(contextNeighborsHydrated);

  const excludeSet = new Set<number>([...sourceSet, ...contextNeighborIds]);

  // n_sources reflects every image listed in source_captions, not just
  // those that contributed to the centroid. Earlier this was set to
  // sourceVectors.length, which produced prompts like "breeding 2
  // existing ones" while the SOURCES block listed 3 -- confusing the
  // model whenever an unembedded image was selected. The avoid-list /
  // far-set still derive from the centroid of embedded sources only;
  // that distinction is opaque to the LLM and intentionally so.
  const promptContext: SeedPrep['promptContext'] = {
    source_captions: sourceCaptions,
    n_sources: sourceIds.length
  };
  if (mode === 'antibreed') {
    promptContext.far_neighbor_captions = neighborCaptions;
  } else {
    promptContext.neighbor_captions = neighborCaptions;
  }

  return { excludeSet, contextNeighborIds, promptContext };
}

// Subtract: first id is the anchor, rest are the images whose embeddings get
// averaged and subtracted from the anchor. Need a single anchor embedding
// and >=1 subtract embedding. The seed vector is anchor - mean(subtracts).
async function prepareSubtract(imageIds: number[]): Promise<SeedPrep> {
  const ids = imageIds.filter((id, i) => imageIds.indexOf(id) === i);
  const anchorId = ids[0];
  const subtractIds = ids.slice(1);
  if (anchorId == null || subtractIds.length === 0) {
    throw new BreedError(
      'no_source_embeddings',
      'subtract needs an anchor image and at least one subtract image.'
    );
  }

  const [anchorVec, subtractVecsRaw] = await Promise.all([
    getCaptionVector(anchorId),
    Promise.all(subtractIds.map((id) => getCaptionVector(id)))
  ]);
  if (!anchorVec) {
    throw new BreedError('no_anchor_embedding', 'anchor image has no caption embedding.');
  }
  const subtractVectors = subtractVecsRaw.filter((v): v is number[] => Array.isArray(v));
  if (subtractVectors.length === 0) {
    throw new BreedError(
      'no_subtract_embeddings',
      'none of the subtract images have caption embeddings.'
    );
  }
  const meanSub = meanVector(subtractVectors);
  const seedVec = subtractVector(anchorVec, meanSub);

  // Find nearest existing images to the resulting point. This is what we
  // show the LLM as "what the math points at," plus what we use to exclude
  // from the output-neighbor strip.
  const sourceSet = new Set<number>([anchorId, ...subtractIds]);
  const rawMatches = await searchByVector(seedVec, {
    limit: AVOID_LIST_SIZE + SEARCH_OVERSHOOT,
    kind: 'caption',
    nsfwMode: 'include'
  });
  const contextNeighborIds = rawMatches
    .map((m) => m.imageId)
    .filter((id) => !sourceSet.has(id))
    .slice(0, AVOID_LIST_SIZE);

  const [anchorRows, subtractRows, contextRows] = await Promise.all([
    getImagesByIdsOrdered([anchorId]),
    getImagesByIdsOrdered(subtractIds),
    getImagesByIdsOrdered(contextNeighborIds)
  ]);
  const [anchorHydrated, subtractHydrated, contextHydrated] = await Promise.all([
    hydrateImages(anchorRows),
    hydrateImages(subtractRows),
    hydrateImages(contextRows)
  ]);

  const excludeSet = new Set<number>([...sourceSet, ...contextNeighborIds]);

  return {
    excludeSet,
    contextNeighborIds,
    promptContext: {
      anchor_caption: formatImagesForPrompt(anchorHydrated),
      subtract_captions: formatImagesForPrompt(subtractHydrated),
      neighbor_captions: formatImagesForPrompt(contextHydrated),
      n_sources: subtractIds.length + 1
    }
  };
}

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
