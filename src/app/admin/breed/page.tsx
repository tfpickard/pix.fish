import { redirect } from 'next/navigation';
import { and, desc, eq } from 'drizzle-orm';
import { auth, isSiteAdmin } from '@/lib/auth';
import { db } from '@/lib/db/client';
import { captions, embeddings, images } from '@/lib/db/schema';
import { BreedClient, type SourceImage } from './_components/breed-client';

export const dynamic = 'force-dynamic';

// Slim picker projection: just enough to render a thumbnail and a hint
// caption, plus a flag for "does this image have a caption embedding."
// Images without an embedding can't contribute to the centroid, so we grey
// them out client-side rather than hiding them outright.
const PICKER_LIMIT = 240;

async function loadPickerImages(ownerId: string): Promise<SourceImage[]> {
  const rows = await db
    .select({
      id: images.id,
      slug: images.slug,
      blobUrl: images.blobUrl,
      captionText: captions.text,
      embeddingId: embeddings.id
    })
    .from(images)
    .leftJoin(
      captions,
      and(eq(captions.imageId, images.id), eq(captions.isSlugSource, true))
    )
    .leftJoin(
      embeddings,
      and(eq(embeddings.imageId, images.id), eq(embeddings.kind, 'caption'))
    )
    .where(eq(images.ownerId, ownerId))
    .orderBy(desc(images.uploadedAt), desc(images.id))
    .limit(PICKER_LIMIT);

  // Dedupe by id -- the LEFT JOIN can fan a row out if multiple captions
  // share isSlugSource (shouldn't happen given the upload flow, but cheap
  // to guard).
  const seen = new Set<number>();
  const out: SourceImage[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({
      id: r.id,
      slug: r.slug,
      blobUrl: r.blobUrl,
      caption: r.captionText ?? null,
      hasEmbedding: r.embeddingId != null
    });
  }
  return out;
}

export default async function AdminBreedPage() {
  const session = await auth();
  if (!isSiteAdmin(session) || !session?.user?.id) redirect('/admin/upload');

  const picker = await loadPickerImages(session.user.id);

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="font-display text-3xl text-ink-100">breed</h1>
        <p className="font-mono text-xs text-ink-500">
          select two or more images. their caption embeddings are averaged into a centroid;
          the model is shown the sources and told to imagine a spiritual successor that lives
          near that centroid without duplicating its nearest existing neighbors.
        </p>
        <p className="font-mono text-xs text-ink-500">
          images without a caption embedding are dimmed -- they can still be passed to the
          model as semantic context, but won&apos;t contribute to the centroid.
        </p>
      </header>
      <BreedClient sources={picker} />
    </div>
  );
}
