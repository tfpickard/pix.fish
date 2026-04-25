import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { captions, descriptions, images, tags } from '@/lib/db/schema';
import { getEmbedder, type AiConfigMap, type UserProviderKeys } from '@/lib/ai';
import { upsertEmbedding } from '@/lib/db/queries/embeddings';
import { uniquifySlug, pushSlugToHistory } from '@/lib/db/queries/slugs';
import { getImageBySlug } from '@/lib/db/queries/images';
import { slugify } from '@/lib/slug';
import { emit } from '@/lib/webhooks/emit';
import type { EnrichmentResult } from '@/lib/enrichment';

// Postgres unique-violation. Drizzle surfaces it via the underlying driver
// error, which for @vercel/postgres carries `code: '23505'` on err.cause.
function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const candidates = [err, (err as { cause?: unknown }).cause];
  for (const c of candidates) {
    if (c && typeof c === 'object' && 'code' in c && (c as { code?: unknown }).code === '23505') {
      return true;
    }
  }
  return false;
}

const MAX_SLUG_RETRIES = 5;

/**
 * Persist an enrichment result for an image that currently holds a
 * placeholder slug. Runs the captions/descriptions/tags insert + slug UPDATE
 * atomically, retrying the slug step on 23505 so parallel jobs computing
 * the same base slug settle into -2, -3, ... suffixes.
 *
 * After the transaction commits: upsert caption embedding, then fire the
 * image.created webhook. Both are best-effort log-and-continue so a vendor
 * blip doesn't orphan the row.
 */
export async function persistEnrichment(args: {
  imageId: number;
  placeholderSlug: string;
  manualCaption?: string;
  enrichment: EnrichmentResult;
  cfg: AiConfigMap;
  userKeys: UserProviderKeys;
}): Promise<void> {
  const { imageId, placeholderSlug, manualCaption, enrichment, cfg, userKeys } = args;

  const slugSourceText = manualCaption ?? enrichment.captions[0]?.text ?? placeholderSlug;
  const slugBase = slugify(slugSourceText) || placeholderSlug;

  let finalSlug = placeholderSlug;
  for (let attempt = 0; attempt < MAX_SLUG_RETRIES; attempt++) {
    const candidate = await uniquifySlug(slugBase, imageId);
    try {
      await db.transaction(async (tx) => {
        // Insert/replace relations first so a subsequent slug collision
        // rollback also rolls these back. Delete any existing rows because
        // the handler may be running on retry after a partial failure.
        await tx.delete(captions).where(eq(captions.imageId, imageId));
        await tx.delete(descriptions).where(eq(descriptions.imageId, imageId));
        await tx.delete(tags).where(eq(tags.imageId, imageId));

        const capRows = enrichment.captions.map((c, i) => ({
          imageId,
          variant: i + 1,
          text: c.text,
          provider: c.provider,
          model: c.model,
          isSlugSource: i === 0 && !manualCaption,
          locked: false
        }));
        if (manualCaption) {
          capRows.push({
            imageId,
            variant: 4,
            text: manualCaption,
            provider: 'manual',
            model: 'manual',
            isSlugSource: true,
            locked: true
          });
        }
        if (capRows.length > 0) await tx.insert(captions).values(capRows);

        if (enrichment.descriptions.length > 0) {
          await tx.insert(descriptions).values(
            enrichment.descriptions.map((d, i) => ({
              imageId,
              variant: i + 1,
              text: d.text,
              provider: d.provider,
              model: d.model,
              locked: false
            }))
          );
        }

        if (enrichment.tags.length > 0) {
          await tx
            .insert(tags)
            .values(
              enrichment.tags.map((t) => ({
                imageId,
                tag: t.tag,
                source: t.source,
                confidence: t.confidence ?? null,
                provider: t.provider,
                model: t.model
              }))
            )
            .onConflictDoNothing();
        }

        if (candidate !== placeholderSlug) {
          await tx.update(images).set({ slug: candidate }).where(eq(images.id, imageId));
        }
      });
      finalSlug = candidate;
      break;
    } catch (err) {
      if (isUniqueViolation(err) && attempt < MAX_SLUG_RETRIES - 1) {
        // Another job claimed this slug between our uniquify check and the
        // UPDATE. Loop to pick the next free suffix.
        continue;
      }
      throw err;
    }
  }

  // Track the prior placeholder in slug_history so old links keep resolving.
  if (finalSlug !== placeholderSlug) {
    await pushSlugToHistory(imageId, placeholderSlug);
  }

  // Caption embedding -- best effort, and only attempted when this user
  // has a key for the configured embeddings provider. A user without an
  // OpenAI key gets no embedding row, which means their image is excluded
  // from semantic search but everything else (tag search, palette, recency
  // sort) still works. A failure here leaves the image eligible for
  // scripts/backfill-embeddings.ts.
  const embedder = getEmbedder(cfg, userKeys);
  if (embedder) {
    try {
      const vec = await embedder.embed(slugSourceText);
      await upsertEmbedding({
        imageId,
        kind: 'caption',
        vec,
        provider: embedder.name,
        model: embedder.model
      });
    } catch (err) {
      console.error('embedding generation failed for image', imageId, err);
    }
  }

  // Webhook fan-out -- also best effort; emit() only enqueues delivery jobs.
  try {
    const full = await getImageBySlug(finalSlug);
    if (full) {
      await emit('image.created', {
        image: {
          id: full.id,
          slug: full.slug,
          blobUrl: full.blobUrl,
          width: full.width,
          height: full.height,
          takenAt: full.takenAt ? full.takenAt.toISOString() : null,
          uploadedAt: full.uploadedAt.toISOString()
        },
        captions: full.captions.map((c) => ({
          variant: c.variant,
          text: c.text,
          isSlugSource: c.isSlugSource
        })),
        tags: full.tags.map((t) => ({
          tag: t.tag,
          source: t.source as 'taxonomy' | 'freeform',
          confidence: t.confidence
        }))
      });
    }
  } catch (err) {
    console.error('image.created webhook emit failed for image', imageId, err);
  }
}
