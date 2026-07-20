import { getProvider } from './index';
import { loadAiConfig } from './loadConfig';
import { loadUserProviderKeys } from './keys';

// A dedicated NSFW classifier for the batch scan. Routes through the 'nsfw'
// ai_config field (default: cheap Haiku -- see defaultAiConfig), so the owner can
// repoint it from /admin/ai like any other field. It reuses the shared provider's
// tags() path (parseTagsJson reads the `nsfw` bit and tolerates an empty `tags`
// array) and the seeded 'nsfw' prompt.
//
// Default model id (dated, not the alias) so a reprocess can diff provenance
// against a specific snapshot; mirrored in config.ts defaultAiConfig.
export const NSFW_SCAN_MODEL = 'claude-haiku-4-5-20251001';

// Resolves the owner's Anthropic key (with env-var fallback, exactly like
// reprocess/enrichment). Returns null when there is no usable key -- callers
// must treat null as "skip this image" rather than defaulting the verdict.
export async function getNsfwClassifier(ownerId: string): Promise<{
  model: string;
  classify: (image: Buffer, mime: string, prompt: string, imageUrl?: string) => Promise<boolean>;
} | null> {
  const cfg = await loadAiConfig();
  const keys = await loadUserProviderKeys(ownerId);
  const provider = getProvider('nsfw', cfg, keys);
  if (!provider) return null; // no usable key for the configured nsfw provider

  return {
    model: provider.model,
    async classify(image, mime, prompt, imageUrl) {
      // tags() returns { tags, nsfw }; the 'nsfw' prompt yields an empty tags
      // array, so we only consume the nsfw bit.
      const result = await provider.tags(image, mime, prompt, imageUrl);
      return result.nsfw;
    }
  };
}
