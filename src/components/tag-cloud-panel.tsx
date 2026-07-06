'use client';

import { useState } from 'react';

type Props = {
  count: number;
  children: React.ReactNode;
};

// Responsive wrapper around the server-rendered <TagCloud>.
//
// At lg+ the cloud floats in the right-hand column and is always visible --
// that path is 100% server-rendered (no hydration flash): the toggle is
// `lg:hidden` and the cloud is `lg:block`.
//
// Below lg the whole layout collapses to one column and the aside is forced
// `order-first`, so an always-expanded disc sat on top of the image grid and
// filled the entire viewport -- on an iPad the first picture landed fully
// below the fold and looked like it wasn't there at all. Here the cloud is
// collapsed behind a toggle so the header + this one-line control are all
// that precede the images, and the first picture is visible on load.
export function TagCloudPanel({ count, children }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-md border border-ink-800/80 bg-ink-950/40 px-4 py-2 font-mono text-xs uppercase tracking-wider text-ink-500 hover:text-ink-100 lg:hidden"
      >
        <span>{open ? 'hide tags' : `browse tags (${count})`}</span>
        <span aria-hidden="true">{open ? '–' : '+'}</span>
      </button>
      {/* Hidden on mobile until toggled; always shown at lg+. Rendered on the
          server either way so the desktop disc needs no JS to appear. */}
      <div className={`${open ? 'mt-3 block' : 'hidden'} lg:mt-0 lg:block`}>
        {children}
      </div>
    </div>
  );
}
