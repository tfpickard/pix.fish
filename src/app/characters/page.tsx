import type { Metadata } from 'next';
import Link from 'next/link';
import { listVisibleCharacters } from '@/lib/db/queries/characters';
import type { Character } from '@/lib/db/schema';
import { readNsfwMode } from '@/lib/nsfw';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'recurring subjects',
  description:
    'Recurring characters the archive has recognized across multiple specimens -- persons of interest, filed and cross-referenced.',
  alternates: { canonical: '/characters' }
};

export default async function CharactersPage() {
  const nsfwMode = await readNsfwMode();
  let chars: Character[] = [];
  try {
    chars = await listVisibleCharacters({ nsfwMode });
  } catch (err) {
    console.error('characters page: listVisibleCharacters failed', err);
  }

  return (
    <div className="space-y-6 pt-8">
      <header className="space-y-2">
        <h1 className="font-fungal-lite text-3xl text-ink-100">recurring subjects</h1>
        <p className="font-mono text-xs text-ink-500">
          figures the archive has found in more than one specimen.
        </p>
      </header>

      {chars.length === 0 ? (
        <p className="font-mono text-xs text-ink-500">no recurring subjects on file yet.</p>
      ) : (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {chars.map((c) => (
            <li key={c.key}>
              <Link href={`/characters/${c.key}`} prefetch={false} className="group block space-y-2">
                <div className="aspect-square overflow-hidden rounded border border-ink-800 bg-ink-900/30">
                  {c.canonicalCropUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={c.canonicalCropUrl}
                      alt={c.name}
                      loading="lazy"
                      decoding="async"
                      className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
                    />
                  ) : null}
                </div>
                <div className="space-y-0.5">
                  <p className="prose-caption text-sm leading-snug text-ink-100">{c.name}</p>
                  <p className="font-mono text-xs text-ink-500">
                    {c.appearanceCount} appearance{c.appearanceCount === 1 ? '' : 's'}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
