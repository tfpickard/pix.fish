'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

const COOKIE = 'pf_show_nsfw';

function readCookie(): boolean {
  if (typeof document === 'undefined') return false;
  const m = document.cookie.match(new RegExp(`(?:^|; )${COOKIE}=([^;]*)`));
  return m?.[1] === 'true';
}

// Tiny visitor-facing toggle that flips the SHOW_NSFW_COOKIE on the
// server, then refreshes the current page so the next render filters
// rows server-side. Keeping the filter at the query layer (not CSS blur)
// means a default-hide visitor never receives the URL of an NSFW image
// over the wire.
export function NsfwToggle() {
  const [showing, setShowing] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();

  useEffect(() => {
    setShowing(readCookie());
  }, []);

  return (
    <button
      type="button"
      onClick={() => {
        start(async () => {
          const res = await fetch('/api/nsfw-toggle', { method: 'POST' });
          if (!res.ok) return;
          const data = (await res.json()) as { showNsfw: boolean };
          setShowing(data.showNsfw);
          router.refresh();
        });
      }}
      className="font-mono text-xs text-ink-500 hover:text-ink-300 disabled:opacity-50"
      disabled={pending}
      aria-pressed={showing}
    >
      {showing ? 'hide nsfw' : 'show nsfw'}
    </button>
  );
}
