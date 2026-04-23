import { getProvider, type AITag, type AiConfigMap } from '@/lib/ai';
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
 * Caller is responsible for persisting the results and for loading aiConfig
 * once (via loadAiConfig) to pass in as cfg.
 *
 * `imageUrl` (optional) lets providers fetch the image remotely instead of
 * base64-encoding the buffer inline. Anthropic's base64 path caps at 5 MB;
 * pass the public blob URL here to sidestep that limit.
 */
export async function enrichImage(
  buffer: Buffer,
  mime: string,
  cfg: AiConfigMap,
  manualCaption?: string,
  imageUrl?: string
): Promise<EnrichmentResult> {
  const [captionPrompt, descriptionPrompt, tagsPrompt] = await Promise.all([
    resolvePrompt('caption', { existing_caption: manualCaption }),
    resolvePrompt('description', { existing_caption: manualCaption }),
    resolvePrompt('tags')
  ]);

  const captionsProvider = getProvider('captions', cfg);
  const descriptionsProvider = getProvider('descriptions', cfg);
  const tagsProvider = getProvider('tags', cfg);

  const [captionsRaw, descriptionsRaw, tagsRaw] = await Promise.all([
    captionsProvider.captions(buffer, mime, captionPrompt, imageUrl),
    descriptionsProvider.descriptions(buffer, mime, descriptionPrompt, imageUrl),
    tagsProvider.tags(buffer, mime, tagsPrompt, imageUrl)
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
