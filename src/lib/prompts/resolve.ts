import { getPromptByKey, type PromptKey } from '@/lib/db/queries/prompts';
import { formatTaxonomyForPrompt, listTaxonomy } from '@/lib/db/queries/taxonomy';

export type ResolveContext = {
  existing_caption?: string;
  variant_number?: number;
  // Breed-specific context. Pre-formatted strings -- the caller is responsible
  // for serialising source/neighbor rows into prompt-friendly JSON so this
  // resolver stays a dumb find/replace.
  source_captions?: string;
  neighbor_captions?: string;
  n_sources?: number;
  // subtract-mode: A vs B's. Both are pre-formatted prompt-friendly text.
  anchor_caption?: string;
  subtract_captions?: string;
  // Optional centroid-anchor neighbor text used by antibreed: the existing
  // images that sit FARTHEST from the centroid, used as positive references.
  far_neighbor_captions?: string;
};

/**
 * Load a prompt template from DB and substitute {{placeholders}}.
 *
 * Supported placeholders:
 *   {{tag_taxonomy}}      -- expanded from the `tag_taxonomy` table
 *   {{existing_caption}}  -- owner-provided caption, if any
 *   {{variant_number}}    -- 1/2/3; unused in Phase 1 combined-call templates
 *                            but kept supported for future per-variant splits.
 *   {{source_captions}}   -- breed: serialised source images
 *   {{neighbor_captions}} -- breed: serialised nearest-existing images
 *   {{n_sources}}         -- breed: number of selected source images
 */
export async function resolvePrompt(
  key: PromptKey,
  ctx: ResolveContext = {}
): Promise<string> {
  const template = await getPromptByKey(key);
  if (!template) {
    throw new Error(`Prompt template "${key}" not found. Did you run 'bun run db:seed'?`);
  }

  let out = template;

  if (out.includes('{{tag_taxonomy}}')) {
    const entries = await listTaxonomy();
    out = out.replaceAll('{{tag_taxonomy}}', formatTaxonomyForPrompt(entries));
  }

  out = out.replaceAll('{{existing_caption}}', ctx.existing_caption ?? '');
  out = out.replaceAll(
    '{{variant_number}}',
    ctx.variant_number !== undefined ? String(ctx.variant_number) : ''
  );
  out = out.replaceAll('{{source_captions}}', ctx.source_captions ?? '');
  out = out.replaceAll('{{neighbor_captions}}', ctx.neighbor_captions ?? '');
  out = out.replaceAll('{{far_neighbor_captions}}', ctx.far_neighbor_captions ?? '');
  out = out.replaceAll('{{anchor_caption}}', ctx.anchor_caption ?? '');
  out = out.replaceAll('{{subtract_captions}}', ctx.subtract_captions ?? '');
  out = out.replaceAll(
    '{{n_sources}}',
    ctx.n_sources !== undefined ? String(ctx.n_sources) : ''
  );

  return out;
}
