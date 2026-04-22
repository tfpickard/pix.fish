/**
 * One-shot backfill for Phase 1 images that pre-date Phase 2 embeddings.
 *
 * Walks images that have no `caption`-kind embedding, computes one from the
 * slug-source caption (or first caption if none flagged), and writes it.
 *
 * Safe to run repeatedly -- upsert on (image_id, kind).
 *
 *   bun scripts/backfill-embeddings.ts
 */
import { asc, eq, isNull, sql } from 'drizzle-orm';
import { getEmbedder } from '../src/lib/ai';
import { db } from '../src/lib/db/client';
import { captions, embeddings, images } from '../src/lib/db/schema';
import { upsertEmbedding } from '../src/lib/db/queries/embeddings';

async function main() {
  const rows = await db
    .select({ imageId: images.id, slug: images.slug, manualCaption: images.manualCaption })
    .from(images)
    .leftJoin(
      embeddings,
      sql`${embeddings.imageId} = ${images.id} AND ${embeddings.kind} = 'caption'`
    )
    .where(isNull(embeddings.id))
    .orderBy(asc(images.id));

  if (rows.length === 0) {
    console.log('no images need backfill');
    return;
  }

  console.log(`backfilling ${rows.length} image(s)`);
  const embedder = getEmbedder();

  let ok = 0;
  let fail = 0;
  for (const row of rows) {
    const slugSource = await db
      .select({ text: captions.text })
      .from(captions)
      .where(eq(captions.imageId, row.imageId))
      .orderBy(sql`${captions.isSlugSource} DESC`, asc(captions.variant))
      .limit(1);
    const text = row.manualCaption ?? slugSource[0]?.text ?? row.slug;
    try {
      const vec = await embedder.embed(text);
      await upsertEmbedding({
        imageId: row.imageId,
        kind: 'caption',
        vec,
        provider: embedder.name,
        model: embedder.model
      });
      ok++;
      console.log(`  [${row.imageId}] ${row.slug} -- ok`);
    } catch (err) {
      fail++;
      console.error(`  [${row.imageId}] ${row.slug} -- failed:`, err);
    }
  }

  console.log(`done: ${ok} ok, ${fail} failed`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then(() => process.exit(0));
