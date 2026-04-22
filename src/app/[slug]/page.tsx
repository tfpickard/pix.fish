import Image from 'next/image';
import Link from 'next/link';
import { notFound, permanentRedirect } from 'next/navigation';
import { getImageBySlug } from '@/lib/db/queries/images';
import { lookupRedirect } from '@/lib/db/queries/slugs';
import { pickOne } from '@/lib/random';

export const dynamic = 'force-dynamic';

export default async function ImageDetailPage({ params }: { params: { slug: string } }) {
  const slug = decodeURIComponent(params.slug);

  const img = await getImageBySlug(slug);
  if (!img) {
    const to = await lookupRedirect(slug);
    if (to) permanentRedirect(`/${to}`);
    notFound();
  }

  const caption = pickOne(img.captions)?.text ?? '';
  const description = pickOne(img.descriptions)?.text ?? '';
  const uploaded = new Date(img.uploadedAt).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });

  return (
    <article className="space-y-8 pt-6">
      <div className="relative mx-auto max-w-4xl">
        {img.width && img.height ? (
          <Image
            src={img.blobUrl}
            alt={caption || img.slug}
            width={img.width}
            height={img.height}
            className="h-auto w-full rounded-lg border border-ink-800"
            priority
          />
        ) : (
          <img
            src={img.blobUrl}
            alt={caption || img.slug}
            className="h-auto w-full rounded-lg border border-ink-800"
          />
        )}
      </div>

      <div className="mx-auto max-w-2xl space-y-6">
        {caption ? (
          <h1 className="prose-caption text-center text-2xl leading-snug text-ink-100 sm:text-3xl">
            {caption}
          </h1>
        ) : null}
        {description ? (
          <p className="prose-caption mx-auto max-w-prose text-center text-base text-ink-300">
            {description}
          </p>
        ) : null}

        {img.tags.length > 0 ? (
          <div className="flex flex-wrap justify-center gap-1.5 pt-2">
            {img.tags.map((t) => (
              <Link key={t.id} href={`/?tag=${encodeURIComponent(t.tag)}`} className="chip">
                {t.tag}
              </Link>
            ))}
          </div>
        ) : null}

        <p className="text-center font-mono text-xs text-ink-500">{uploaded}</p>

        <section
          aria-label="reactions"
          className="border-t border-ink-800 pt-4 text-center font-mono text-xs text-ink-600"
        >
          reactions -- coming in phase 3
        </section>
        <section
          aria-label="comments"
          className="border-t border-ink-800 pt-4 text-center font-mono text-xs text-ink-600"
        >
          comments -- coming in phase 3
        </section>
      </div>
    </article>
  );
}
