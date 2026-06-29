import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getClerk } from '@/lib/db/queries/clerks';
import {
  getCharacter,
  listAppearances,
  visibleAppearanceImageIds
} from '@/lib/db/queries/characters';
import { imageRefsByIds } from '@/lib/db/queries/images';
import { readNsfwMode } from '@/lib/nsfw';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function generateMetadata({
  params
}: {
  params: { key: string };
}): Promise<Metadata> {
  const character = await getCharacter(params.key).catch(() => null);
  const name = character?.name ?? 'subject';
  return {
    title: name,
    description: character?.dossier?.slice(0, 160) ?? 'A recurring subject of the archive.',
    alternates: { canonical: `/characters/${params.key}` },
    robots: { index: false, follow: true }
  };
}

export default async function CharacterPage({ params }: { params: { key: string } }) {
  const character = await getCharacter(params.key);
  if (!character) notFound();

  const nsfwMode = await readNsfwMode();
  const appearances = await listAppearances(params.key).catch(() => []);
  const ids = appearances.map((a) => a.imageId);
  const [visibleIds, refs, clerk] = await Promise.all([
    visibleAppearanceImageIds(ids, { nsfwMode }).catch(() => new Set<number>()),
    imageRefsByIds(ids).catch(() => new Map()),
    getClerk(character.clerkSlug).catch(() => null)
  ]);
  const visible = appearances.filter((a) => visibleIds.has(a.imageId));

  return (
    <article className="mx-auto max-w-2xl space-y-8 pt-10 pb-16">
      <header className="flex items-start gap-4">
        {character.canonicalCropUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={character.canonicalCropUrl}
            alt={character.name}
            width={96}
            height={96}
            className="h-24 w-24 shrink-0 rounded border border-ink-800 object-cover"
          />
        ) : null}
        <div className="space-y-1">
          <h1 className="font-fungal-lite text-3xl text-ink-100">{character.name}</h1>
          <p className="font-mono text-xs text-ink-500">
            recurring subject &middot; {visible.length} appearance{visible.length === 1 ? '' : 's'} on record
          </p>
        </div>
      </header>

      <section className="space-y-3">
        <div className="prose-caption whitespace-pre-line text-base leading-relaxed text-ink-100">
          {character.dossier}
        </div>
        <p className="font-mono text-xs text-ink-500">
          filed by{' '}
          <span className="text-ink-200">{clerk?.name ?? character.clerkSlug}</span>
          {clerk ? <>, {clerk.department}</> : null}
        </p>
      </section>

      {visible.length > 0 ? (
        <section className="space-y-3 border-t border-ink-800 pt-6">
          <h2 className="font-mono text-xs uppercase tracking-wide text-ink-500">appears in</h2>
          <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4">
            {visible.map((a) => {
              const ref = refs.get(a.imageId);
              const href = ref?.handle ? `/u/${ref.handle}/${ref.slug}` : ref ? `/${ref.slug}` : '#';
              return (
                <li key={a.imageId}>
                  <Link
                    href={href}
                    prefetch={false}
                    className="group block aspect-square overflow-hidden rounded border border-ink-800/60 bg-ink-900/30"
                  >
                    {a.cropUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={a.cropUrl}
                        alt={ref?.slug ?? `specimen ${a.imageId}`}
                        loading="lazy"
                        decoding="async"
                        className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
                      />
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </article>
  );
}
