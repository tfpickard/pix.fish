import { createAnthropicProvider } from './anthropic';
import { loadUserProviderKeys } from './keys';

// feat/hud: a dedicated, cheap nudity classifier for the batch NSFW scan.
//
// Pinned to Anthropic Haiku regardless of the ai_config routing -- the scan is
// a high-volume, single-bit pass, so it always uses the cheapest vision model
// rather than whatever the owner has captions/tags pointed at. It reuses the
// shared Anthropic provider's tags() path (which parses with parseTagsJson, so
// it reads `nsfw` and tolerates an empty `tags` array) and the seeded 'nsfw'
// prompt. No SDK calls happen outside src/lib/ai/ -- this module is the only
// place that constructs the Haiku provider.
//
// Pinned model id (not the alias) so a reprocess can later diff provenance and
// so the classification is reproducible against a specific model snapshot.
export const NSFW_SCAN_MODEL = 'claude-haiku-4-5-20251001';

// Resolves the owner's Anthropic key (with env-var fallback, exactly like
// reprocess/enrichment). Returns null when there is no usable key -- callers
// must treat null as "skip this image" rather than defaulting the verdict.
export async function getNsfwClassifier(ownerId: string): Promise<{
  model: string;
  classify: (image: Buffer, mime: string, prompt: string, imageUrl?: string) => Promise<boolean>;
} | null> {
  const keys = await loadUserProviderKeys(ownerId);
  const apiKey = keys.anthropic;
  if (!apiKey) return null;

  const provider = createAnthropicProvider(apiKey, NSFW_SCAN_MODEL);
  return {
    model: NSFW_SCAN_MODEL,
    async classify(image, mime, prompt, imageUrl) {
      // tags() returns { tags, nsfw }; the 'nsfw' prompt yields an empty tags
      // array, so we only consume the nsfw bit.
      const result = await provider.tags(image, mime, prompt, imageUrl);
      return result.nsfw;
    }
  };
}
