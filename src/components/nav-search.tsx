'use client';

import { useSearchParams } from 'next/navigation';

// Echoes the current ?q= back into the input so visitors landing on
// /search?q=foo see "foo" in the bar instead of an empty placeholder.
// `key` rebinds defaultValue when the URL query changes.
export function NavSearch() {
  const params = useSearchParams();
  const q = params.get('q') ?? '';
  return (
    <form action="/search" method="GET" className="ml-auto flex-1 max-w-xs">
      <input
        key={q}
        type="search"
        name="q"
        defaultValue={q}
        placeholder="search semantically..."
        className="w-full rounded-md border border-ink-800 bg-ink-950/60 px-3 py-1.5 font-mono text-xs text-ink-100 placeholder:text-ink-500 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
        aria-label="search"
      />
    </form>
  );
}
