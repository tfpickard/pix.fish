import type { Metadata } from 'next';
import Link from 'next/link';
import { loadChronicleEntries } from '@/lib/universe/chronicle-load';
import type { ChronicleEntry } from '@/lib/universe/chronicle';
import { readNsfwMode } from '@/lib/nsfw';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export const metadata: Metadata = {
  title: 'chronicle',
  description:
    'The archive at work: a running log of intakes, amendments, and flagged contradictions as the institution files and re-files its specimens.',
  alternates: { canonical: '/chronicle' }
};

function fmt(at: string): string {
  return new Date(at).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function EntryRow({ e }: { e: ChronicleEntry }) {
  return (
    <li className="space-y-1 border-b border-ink-800/60 pb-4">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-xs text-ink-500">
        <span className="uppercase tracking-wide text-ink-300">{e.label}</span>
        {e.clerk ? <span>&middot; {e.clerk}</span> : null}
        {e.subjectKind === 'specimen' && e.subjectSlug ? (
          <Link
            href={e.subjectHandle ? `/u/${e.subjectHandle}/${e.subjectSlug}` : `/${e.subjectSlug}`}
            prefetch={false}
            className="underline-offset-2 hover:text-ink-100 hover:underline"
          >
            &middot; {e.subjectSlug}
          </Link>
        ) : null}
        <span className="ml-auto text-ink-600">{fmt(e.at)}</span>
      </div>
      {e.text ? <p className="prose-caption text-sm leading-relaxed text-ink-200">{e.text}</p> : null}
    </li>
  );
}

export default async function ChroniclePage() {
  let entries: ChronicleEntry[] = [];
  try {
    const nsfwMode = await readNsfwMode();
    entries = await loadChronicleEntries(60, nsfwMode);
  } catch (err) {
    console.error('chronicle page: loadChronicleEntries failed', err);
  }

  return (
    <article className="mx-auto max-w-2xl space-y-8 pt-10 pb-16">
      <header className="space-y-2">
        <h1 className="font-fungal-lite text-4xl text-ink-100">chronicle</h1>
        <p className="font-mono text-xs text-ink-500">
          the archive at work -- intakes, amendments, and flagged contradictions, newest first.
        </p>
      </header>

      {entries.length === 0 ? (
        <p className="font-mono text-xs text-ink-500">the record is quiet.</p>
      ) : (
        <ul className="space-y-4">
          {entries.map((e) => (
            <EntryRow key={e.id} e={e} />
          ))}
        </ul>
      )}
    </article>
  );
}
