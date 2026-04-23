import { asc, eq } from 'drizzle-orm';
import type { Job } from '@/lib/db/schema';
import { db } from '@/lib/db/client';
import { captions, descriptions, images, tags } from '@/lib/db/schema';
import { getProvider, getEmbedder, type ProviderField } from '@/lib/ai';
import { loadAiConfig } from '@/lib/ai/loadConfig';
import { resolvePrompt } from '@/lib/prompts';
import { upsertEmbedding } from '@/lib/db/queries/embeddings';
import { deleteField } from '@/lib/db/queries/reprocess';

type Payload = { imageId: number; fields: ProviderField[] };

async function fetchImageBuffer(blobUrl: string): Promise<{ buffer: Buffer; mime: string }> {
  const res = await fetch(blobUrl);
  if (!res.ok) throw new Error(`blob fetch failed: ${res.status}`);
  const mime = res.headers.get('content-type') ?? 'image/jpeg';
  const arr = await res.arrayBuffer();
  return { buffer: Buffer.from(arr), mime };
}

export async function reprocessImageHandler(job: Job): Promise<void> {
  const payload = job.payload as Payload;
  const [img] = await db.select().from(images).where(eq(images.id, payload.imageId)).limit(1);
  if (!img) return;

  const cfg = await loadAiConfig();

  // Only fetch the buffer if at least one vision-backed field is requested.
  const visionFields: ProviderField[] = payload.fields.filter((f) => f !== 'embeddings');
  let img_bytes: { buffer: Buffer; mime: string } | null = null;
  if (visionFields.length > 0) {
    img_bytes = await fetchImageBuffer(img.blobUrl);
  }

  for (const field of payload.fields) {
    if (field === 'captions' || field === 'descriptions') {
      const provider = getProvider(field, cfg);
      const promptKey = field === 'captions' ? 'caption' : 'description';
      const prompt = await resolvePrompt(promptKey, { existing_caption: img.manualCaption ?? undefined });
      const variants = await provider[field](img_bytes!.buffer, img_bytes!.mime, prompt);
      await db.transaction(async (tx) => {
        await deleteField(img.id, field);
        const table = field === 'captions' ? captions : descriptions;
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
      const provider = getProvider('tags', cfg);
      const prompt = await resolvePrompt('tags');
      const result = await provider.tags(img_bytes!.buffer, img_bytes!.mime, prompt);
      await db.transaction(async (tx) => {
        await deleteField(img.id, 'tags');
        if (result.length > 0) {
          await tx
            .insert(tags)
            .values(
              result.map((t) => ({
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
      const embedder = getEmbedder(cfg);
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
