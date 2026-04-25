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
  ownerId: string;
  placeholderSlug: string;
  manualCaption?: string;
  // Manual description from the upload form, persisted as variant=4
  // locked=true (mirrors the manual caption shape) so reprocess passes
  // can't clobber it.
  manualDescription?: string;
  // Manual NSFW override from the upload form. true = force-NSFW with
  // source='manual'; the AI verdict is ignored. Undefined = trust the AI
  // (or default false when no AI ran).
  manualNsfw?: boolean;
  // Manual freeform tags from the upload form. Inserted alongside any
  // AI-generated tags; the unique (imageId, tag) constraint dedupes if the
  // AI also produced the same tag.
  manualTags?: string[];
  enrichment: EnrichmentResult;
  cfg: AiConfigMap;
  userKeys: UserProviderKeys;
}): Promise<void> {
  const {
    imageId,
    ownerId,
    placeholderSlug,
    manualCaption,
    manualDescription,
    manualNsfw,
    manualTags,
    enrichment,
    cfg,
    userKeys
  } = args;
  // NSFW resolution. Manual override always wins. Otherwise, if the AI
  // tag pass actually executed (regardless of whether it produced any
  // tags) we trust its nsfw verdict with source='auto'; if no provider
  // ran (key-less user) we fall through to manualNsfw with source='manual',
  // defaulting false.
  const isNsfw = manualNsfw === true ? true : enrichment.tagsRan ? enrichment.nsfw : !!manualNsfw;
  const nsfwSource: 'auto' | 'manual' =
    manualNsfw !== undefined || !enrichment.tagsRan ? 'manual' : 'auto';

  const slugSourceText = manualCaption ?? enrichment.captions[0]?.text ?? placeholderSlug;
  const slugBase = slugify(slugSourceText) || placeholderSlug;

  let finalSlug = placeholderSlug;
  for (let attempt = 0; attempt < MAX_SLUG_RETRIES; attempt++) {
    const candidate = await uniquifySlug(slugBase, ownerId, imageId);
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

        const descRows = enrichment.descriptions.map((d, i) => ({
          imageId,
          variant: i + 1,
          text: d.text,
          provider: d.provider as string | null,
          model: d.model as string | null,
          locked: false
        }));
        if (manualDescription) {
          descRows.push({
            imageId,
            variant: 4,
            text: manualDescription,
            provider: null,
            model: null,
            locked: true
          });
        }
        if (descRows.length > 0) await tx.insert(descriptions).values(descRows);

        const allTags = [
          ...enrichment.tags.map((t) => ({
            imageId,
            tag: t.tag,
            source: t.source,
            confidence: t.confidence ?? null,
            provider: t.provider as string | null,
            model: t.model as string | null
          })),
          ...(manualTags ?? [])
            .map((raw) => raw.trim().toLowerCase())
            .filter(Boolean)
            .map((tag) => ({
              imageId,
              tag,
              source: 'freeform' as const,
              confidence: null as number | null,
              provider: null as string | null,
              model: null as string | null
            }))
        ];
        if (allTags.length > 0) {
          await tx.insert(tags).values(allTags).onConflictDoNothing();
        }

        // Apply NSFW + final slug update in the same tx as captions/tags so
        // a unique-violation rollback also reverts the flag.
        const updates: Record<string, unknown> = {
          isNsfw,
          nsfwSource
        };
        if (candidate !== placeholderSlug) updates.slug = candidate;
        await tx.update(images).set(updates).where(eq(images.id, imageId));
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
