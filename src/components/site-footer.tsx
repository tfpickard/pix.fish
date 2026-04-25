import Link from 'next/link';

// One-line monospace footer. Closes the page so the last image card
// doesn't feel like the site fell off the bottom.
export function SiteFooter() {
  return (
    <footer className="mx-auto mt-16 w-full max-w-6xl border-t border-ink-800/60 px-4 py-6 font-mono text-xs text-ink-500">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>pix.fish &middot; a small image gallery</span>
        <nav className="flex items-center gap-4">
          <Link href="/about" className="hover:text-ink-200 transition-colors">
            about
          </Link>
          <Link href="/map" className="hover:text-ink-200 transition-colors">
            map
          </Link>
          <Link href="/feed.json" className="hover:text-ink-200 transition-colors">
            feed
          </Link>
        </nav>
      </div>
    </footer>
  );
}
