import type { Metadata } from 'next';
import Link from 'next/link';

// The archive had no 404 of its own, so a bad slug fell through to Next's
// default -- a bare "404 | This page could not be found" in system type, the
// one surface where the whole conceit visibly dropped. A miss is a good place
// for the bit: an institution that cannot find a file does not apologize, it
// speculates about what happened to it.
export const metadata: Metadata = {
  title: 'no such specimen',
  robots: { index: false, follow: true }
};

export default function NotFound() {
  return (
    <div className="space-y-6 pt-8">
      <section className="mx-auto max-w-2xl space-y-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-700">
          / department of intake and reassignment /
        </p>
        <h1 className="font-fungal-lite text-3xl leading-snug text-ink-100">no such specimen</h1>
        <p className="font-mono text-xs leading-relaxed text-ink-500">
          The requested file is not held at this reference. It may have been reassigned to another
          category, withdrawn from circulation pending adjudication, or never accessioned at all.
          The clerks have filed three accounts and none of them agree.
        </p>
        <p className="font-mono text-xs leading-relaxed text-ink-600">
          Cross-reference is available to any visitor. The archive recommends browsing until
          something looks familiar.
        </p>
      </section>

      <section className="mx-auto flex max-w-2xl flex-wrap items-center gap-4">
        <Link
          href="/"
          className="rounded border border-primary/50 bg-primary/10 px-4 py-1.5 font-mono text-xs text-primary hover:bg-primary/20"
        >
          return to the stacks
        </Link>
        <Link href="/search" className="font-mono text-xs text-ink-500 hover:text-ink-300">
          search the index
        </Link>
        <Link href="/map" className="font-mono text-xs text-ink-500 hover:text-ink-300">
          consult the atlas
        </Link>
      </section>

      <div className="grid-floor" aria-hidden="true" />
    </div>
  );
}
