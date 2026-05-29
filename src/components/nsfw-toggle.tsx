'use client';

import { Eye, EyeOff } from 'lucide-react';
import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';

const COOKIE = 'pf_show_nsfw';

type NsfwMode = 'hide' | 'include' | 'only';

function readCookieMode(): NsfwMode {
  if (typeof document === 'undefined') return 'hide';
  const m = document.cookie.match(new RegExp(`(?:^|; )${COOKIE}=([^;]*)`));
  const val = m?.[1];
  if (val === 'true') return 'include';
  if (val === 'only') return 'only';
  return 'hide';
}

const MODE_CONFIG: Record<NsfwMode, { label: string; nextLabel: string; icon: typeof Eye; className: string }> = {
  hide:    { label: 'nsfw hidden',  nextLabel: 'show nsfw',    icon: EyeOff, className: 'text-ink-500' },
  include: { label: 'nsfw visible', nextLabel: 'nsfw only',    icon: Eye,    className: 'text-ink-400' },
  only:    { label: 'nsfw only',    nextLabel: 'hide nsfw',    icon: Eye,    className: 'text-amber-400' },
};

// Cycles the visitor NSFW preference through three states:
//   hide -> include -> only -> hide
// Each click calls the server to advance the cookie, then refreshes so
// the query layer re-filters rows server-side.
export function NsfwToggle() {
  const [mode, setMode] = useState<NsfwMode>('hide');
  const [pending, start] = useTransition();
  const router = useRouter();

  useEffect(() => {
    setMode(readCookieMode());
  }, []);

  const { label, nextLabel, icon: Icon, className } = MODE_CONFIG[mode];

  return (
    <button
      type="button"
      onClick={() => {
        start(async () => {
          const res = await fetch('/api/nsfw-toggle', { method: 'POST' });
          if (!res.ok) return;
          const data = (await res.json()) as { nsfwMode: NsfwMode };
          setMode(data.nsfwMode);
          router.refresh();
        });
      }}
      className={`transition-colors hover:text-ink-100 disabled:opacity-50 ${className}`}
      disabled={pending}
      aria-label={nextLabel}
      title={`${label} -- click to ${nextLabel}`}
    >
      <Icon size={14} strokeWidth={1.75} />
    </button>
  );
}
