import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Job } from '@/lib/db/schema';
import { db } from '@/lib/db/client';
import { captions, descriptions, images, tags } from '@/lib/db/schema';
import { getProvider, getEmbedder, loadUserProviderKeys, type ProviderField } from '@/lib/ai';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { resolvePrompt } from '@/lib/prompts';
import { upsertEmbedding } from '@/lib/db/queries/embeddings';

type Payload = { imageId: number; fields: ProviderField[] };

// Providers now prefer URL source (Anthropic + OpenAI both accept it), so
// the Buffer arg is a legacy-path fallback only. Passing an empty buffer +
// the blob URL keeps us from round-tripping the image through this function.
const EMPTY_BUFFER = Buffer.alloc(0);

export async function reprocessImageHandler(job: Job): Promise<void> {
  const payload = job.payload as Payload;
  const [img] = await db.select().from(images).where(eq(images.id, payload.imageId)).limit(1);
  if (!img) return;

  const cfg = await loadAiConfig();
  const userKeys = await loadUserProviderKeys(img.ownerId);
  const mime = img.mime ?? 'image/jpeg';

  for (const field of payload.fields) {
    if (field === 'captions' || field === 'descriptions') {
      const provider = getProvider(field, cfg, userKeys);
      // No key for the configured provider -- skip silently. Reprocess is
      // best-effort; the image keeps whatever variants it already has.
      if (!provider) continue;
      const promptKey = field === 'captions' ? 'caption' : 'description';
      const prompt = await resolvePrompt(promptKey, { existing_caption: img.manualCaption ?? undefined });
      const variants = await provider[field](EMPTY_BUFFER, mime, prompt, img.blobUrl);
      await db.transaction(async (tx) => {
        // Delete the AI variants (1..3) via tx so the replace is atomic with
        // the insert below. Variant=4 is the manual caption and locked=true,
        // so preserve it across reprocesses.
        const table = field === 'captions' ? captions : descriptions;
        await tx
          .delete(table)
          .where(and(eq(table.imageId, img.id), inArray(table.variant, [1, 2, 3])));
        const rows = variants.slice(0, 3).map((text, i) => ({
          imageId: img.id,
          variant: i + 1,
          text,
          provider: provider.name,
          model: provider.model,
          ...(field === 'captions' ? { isSlugSource: i === 0 && !img.manualCaption, locked: false } : { locked: false })
        }));
        if (rows.length > 0) await tx.insert(table).values(rows as (typeof rows)[number][]);
      });
    } else if (field === 'tags') {
      const provider = getProvider('tags', cfg, userKeys);
      if (!provider) continue;
      const prompt = await resolvePrompt('tags');
      const result = await provider.tags(EMPTY_BUFFER, mime, prompt, img.blobUrl);
      await db.transaction(async (tx) => {
        // Delete + insert in the same tx so a rollback doesn't leave an
        // image with no tags.
        await tx.delete(tags).where(eq(tags.imageId, img.id));
        if (result.tags.length > 0) {
          await tx
            .insert(tags)
            .values(
              result.tags.map((t) => ({
                imageId: img.id,
                tag: t.tag,
                source: t.source,
                confidence: t.confidence ?? null,
                provider: provider.name,
                model: provider.model
              }))
            )
            .onConflictDoNothing();
        }
        // NSFW: only update if the existing source is 'auto' (or null on
        // legacy rows). A manual override sticks across reprocess.
        if (img.nsfwSource !== 'manual') {
          await tx
            .update(images)
            .set({ isNsfw: result.nsfw, nsfwSource: 'auto' })
            .where(eq(images.id, img.id));
        }
      });
    } else if (field === 'embeddings') {
      // Embed from the slug-source caption (falls back to first caption, then slug).
      const slugRows = await db
        .select({ text: captions.text, isSlugSource: captions.isSlugSource, variant: captions.variant })
        .from(captions)
        .where(eq(captions.imageId, img.id))
        .orderBy(asc(captions.variant));
      const slugSource = slugRows.find((r) => r.isSlugSource) ?? slugRows[0];
      const text = img.manualCaption ?? slugSource?.text ?? img.slug;
      const embedder = getEmbedder(cfg, userKeys);
      if (!embedder) continue;
      const vec = await embedder.embed(text);
      await upsertEmbedding({
        imageId: img.id,
        kind: 'caption',
        vec,
        provider: embedder.name,
        model: embedder.model
      });
    }
  }
}
