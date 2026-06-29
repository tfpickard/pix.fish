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

// Generic, content-free metadata for a character with no visible appearances --
// the page body 404s in that case, so the document metadata must not leak the
// hidden subject's name or dossier excerpt to a direct request.
const HIDDEN_METADATA = (key: string): Metadata => ({
  title: 'subject',
  description: 'A recurring subject of the archive.',
  alternates: { canonical: `/characters/${key}` },
  robots: { index: false, follow: false }
});

export async function generateMetadata({
  params
}: {
  params: { key: string };
}): Promise<Metadata> {
  const character = await getCharacter(params.key).catch(() => null);
  if (!character) return HIDDEN_METADATA(params.key);

  // Same visibility gate as the page body: if nothing is visible for this
  // viewer, return generic metadata instead of the real name/dossier.
  const nsfwMode = await readNsfwMode();
  const appearances = await listAppearances(params.key).catch(() => []);
  const visibleIds = await visibleAppearanceImageIds(
    appearances.map((a) => a.imageId),
    { nsfwMode }
  ).catch(() => new Set<number>());
  if (visibleIds.size === 0) return HIDDEN_METADATA(params.key);

  return {
    title: character.name,
    description: character.dossier?.slice(0, 160) ?? 'A recurring subject of the archive.',
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
  // A character whose every appearance is now NSFW/archived for this viewer has
  // no public footprint -- treat it as not found rather than surfacing a dossier
  // that links to nothing (and leaks the character's existence past the gate).
  if (visible.length === 0) notFound();

  // The header crop must come from a VISIBLE appearance: the stored canonical can
  // point at a crop whose source image was since deleted/hidden. Prefer it when
  // still visible, else the first visible crop.
  const headerCrop =
    visible.find((a) => a.cropUrl && a.cropUrl === character.canonicalCropUrl)?.cropUrl ??
    visible.find((a) => a.cropUrl)?.cropUrl ??
    null;

  return (
    <article className="mx-auto max-w-2xl space-y-8 pt-10 pb-16">
      <header className="flex items-start gap-4">
        {headerCrop ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={headerCrop}
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
