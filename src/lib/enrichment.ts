import { getProvider, type AITag } from '@/lib/ai';
import { resolvePrompt } from '@/lib/prompts';

export type EnrichmentResult = {
  captions: { text: string; provider: string; model: string }[];
  descriptions: { text: string; provider: string; model: string }[];
  tags: { tag: string; source: 'taxonomy' | 'freeform'; confidence?: number; provider: string; model: string }[];
};

/**
 * Run synchronous enrichment across all three fields in parallel.
 *
 * Phase 1: one combined JSON call per field (captions returns all 3 variants).
 * Caller is responsible for persisting the results.
 */
export async function enrichImage(
  buffer: Buffer,
  mime: string,
  manualCaption?: string
): Promise<EnrichmentResult> {
  const [captionPrompt, descriptionPrompt, tagsPrompt] = await Promise.all([
    resolvePrompt('caption', { existing_caption: manualCaption }),
    resolvePrompt('description', { existing_caption: manualCaption }),
    resolvePrompt('tags')
  ]);

  const captionsProvider = getProvider('captions');
  const descriptionsProvider = getProvider('descriptions');
  const tagsProvider = getProvider('tags');

  const [captionsRaw, descriptionsRaw, tagsRaw] = await Promise.all([
    captionsProvider.captions(buffer, mime, captionPrompt),
    descriptionsProvider.descriptions(buffer, mime, descriptionPrompt),
    tagsProvider.tags(buffer, mime, tagsPrompt)
  ]);

  return {
    captions: captionsRaw.slice(0, 3).map((text) => ({
      text,
      provider: captionsProvider.name,
      model: captionsProvider.model
    })),
    descriptions: descriptionsRaw.slice(0, 3).map((text) => ({
      text,
      provider: descriptionsProvider.name,
      model: descriptionsProvider.model
    })),
    tags: tagsRaw.map((t: AITag) => ({
      tag: t.tag,
      source: t.source,
      confidence: t.confidence,
      provider: tagsProvider.name,
      model: tagsProvider.model
    }))
  };
}
