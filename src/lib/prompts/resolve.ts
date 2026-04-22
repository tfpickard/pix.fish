import { getPromptByKey, type PromptKey } from '@/lib/db/queries/prompts';
import { formatTaxonomyForPrompt, listTaxonomy } from '@/lib/db/queries/taxonomy';

export type ResolveContext = {
  existing_caption?: string;
  variant_number?: number;
};

/**
 * Load a prompt template from DB and substitute {{placeholders}}.
 *
 * Supported placeholders:
 *   {{tag_taxonomy}}    -- expanded from the `tag_taxonomy` table
 *   {{existing_caption}} -- owner-provided caption, if any
 *   {{variant_number}}   -- 1/2/3; unused in Phase 1 combined-call templates
 *                          but kept supported for future per-variant splits.
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

  return out;
}
