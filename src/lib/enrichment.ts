import { getProvider, type AITag, type AiConfigMap, type UserProviderKeys } from '@/lib/ai';
import type { TagsAndNsfw } from '@/lib/ai/types';
import { resolvePrompt } from '@/lib/prompts';

export type EnrichmentResult = {
  captions: { text: string; provider: string; model: string }[];
  descriptions: { text: string; provider: string; model: string }[];
  tags: { tag: string; source: 'taxonomy' | 'freeform'; confidence?: number; provider: string; model: string }[];
  // Phase E: the tag pass also classifies NSFW. False when no tag provider
  // ran (key-less user) -- the upload form's manual_nsfw checkbox is the
  // override path in that case.
  nsfw: boolean;
};

/**
 * Run synchronous enrichment across all three fields in parallel.
 *
 * Phase 1: one combined JSON call per field (captions returns all 3 variants).
 * Caller is responsible for persisting the results and for loading aiConfig
 * once (via loadAiConfig) to pass in as cfg.
 *
 * `userKeys` carries the per-user BYO credentials. Any field whose
 * configured provider has no key for this user is silently skipped --
 * captions/descriptions/tags arrays come back empty for those fields, the
 * upload still succeeds, and the user can fill manual values from the
 * upload form.
 *
 * `imageUrl` (optional) lets providers fetch the image remotely instead of
 * base64-encoding the buffer inline. Anthropic's base64 path caps at 5 MB;
 * pass the public blob URL here to sidestep that limit.
 */
export async function enrichImage(
  buffer: Buffer,
  mime: string,
  cfg: AiConfigMap,
  userKeys: UserProviderKeys,
  manualCaption?: string,
  imageUrl?: string
): Promise<EnrichmentResult> {
  const [captionPrompt, descriptionPrompt, tagsPrompt] = await Promise.all([
    resolvePrompt('caption', { existing_caption: manualCaption }),
    resolvePrompt('description', { existing_caption: manualCaption }),
    resolvePrompt('tags')
  ]);

  const captionsProvider = getProvider('captions', cfg, userKeys);
  const descriptionsProvider = getProvider('descriptions', cfg, userKeys);
  const tagsProvider = getProvider('tags', cfg, userKeys);

  const emptyTags: TagsAndNsfw = { tags: [], nsfw: false };
  const [captionsRaw, descriptionsRaw, tagsResult] = await Promise.all([
    captionsProvider
      ? captionsProvider.captions(buffer, mime, captionPrompt, imageUrl)
      : Promise.resolve<string[]>([]),
    descriptionsProvider
      ? descriptionsProvider.descriptions(buffer, mime, descriptionPrompt, imageUrl)
      : Promise.resolve<string[]>([]),
    tagsProvider
      ? tagsProvider.tags(buffer, mime, tagsPrompt, imageUrl)
      : Promise.resolve(emptyTags)
  ]);

  return {
    captions: captionsProvider
      ? captionsRaw.slice(0, 3).map((text) => ({
          text,
          provider: captionsProvider.name,
          model: captionsProvider.model
        }))
      : [],
    descriptions: descriptionsProvider
      ? descriptionsRaw.slice(0, 3).map((text) => ({
          text,
          provider: descriptionsProvider.name,
          model: descriptionsProvider.model
        }))
      : [],
    tags: tagsProvider
      ? tagsResult.tags.map((t: AITag) => ({
          tag: t.tag,
          source: t.source,
          confidence: t.confidence,
          provider: tagsProvider.name,
          model: tagsProvider.model
        }))
      : [],
    // Default false when no tag provider ran -- the upload route applies
    // manual_nsfw on top before persisting.
    nsfw: tagsProvider ? tagsResult.nsfw : false
  };
}
