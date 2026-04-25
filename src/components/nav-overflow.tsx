'use client';

import Link from 'next/link';
import { Menu, X } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ThemeToggle } from '@/components/theme-toggle';
import { ShareButton } from '@/components/share-button';
import { NsfwToggle } from '@/components/nsfw-toggle';

type NavItem = { href: string; label: string };

type Props = {
  signedIn: boolean;
  admin: boolean;
  handle: string | null;
  authed: boolean;
};

// Below sm, the navbar's link row overflows the viewport (gallery, about,
// upload, /u/handle, admin, sign in/out, NSFW, share, theme). This component
// is the inline row at md+ and a popover-from-hamburger below it. The
// individual link components are duplicated rather than abstracted so the
// inline row can stay light and the popover can adopt a different layout.
export function NavOverflow({ signedIn, admin, handle, authed }: Props) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Auto-close when the route changes (Next router push or browser
  // back/forward), and when Escape is pressed. The link onClick handlers
  // also call setOpen(false) for the common case where the user clicks
  // a link in the open menu; the pathname-effect catches everything
  // else (programmatic navigation, popstate, etc).
  useEffect(() => {
    if (!open) return;
    setOpen(false);
    // We only want to react to pathname *changes*, so the eslint
    // exhaustive-deps rule would push us to depend on `open` too --
    // which would loop. Limit deps to pathname.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const items: NavItem[] = [
    { href: '/', label: 'gallery' },
    { href: '/about', label: 'about' },
    ...(signedIn ? [{ href: '/admin/upload', label: 'upload' }] : []),
    ...(handle ? [{ href: `/u/${handle}`, label: `/u/${handle}` }] : []),
    ...(admin ? [{ href: '/admin/ai', label: 'admin' }] : []),
    {
      href: authed ? '/api/auth/signout' : '/api/auth/signin',
      label: authed ? 'sign out' : 'sign in'
    }
  ];

  return (
    <>
      {/* Inline at md+: same flat row as before. */}
      <nav className="hidden items-center gap-4 font-mono text-xs text-ink-400 md:flex">
        {items.map((it) => (
          <Link key={it.href} href={it.href} className="transition-colors hover:text-ink-100">
            {it.label}
          </Link>
        ))}
        <NsfwToggle />
        <ShareButton />
        <ThemeToggle />
      </nav>

      {/* Below md: hamburger + slide-down popover. ShareButton + ThemeToggle
          stay in the bar since they're already icon-only. NSFW moves into
          the popover so the bar stays under viewport width. */}
      <div className="flex items-center gap-3 md:hidden">
        <ShareButton />
        <ThemeToggle />
        <button
          type="button"
          aria-expanded={open}
          aria-controls="nav-overflow-panel"
          aria-label={open ? 'close menu' : 'open menu'}
          onClick={() => setOpen((prev) => !prev)}
          className="text-ink-400 transition-colors hover:text-ink-100"
        >
          {open ? <X size={16} strokeWidth={1.75} /> : <Menu size={16} strokeWidth={1.75} />}
        </button>
      </div>

      {open ? (
        <div
          id="nav-overflow-panel"
          className="absolute inset-x-0 top-14 z-30 border-b border-ink-800/60 bg-ink-950/95 px-4 py-3 backdrop-blur md:hidden"
        >
          <ul className="flex flex-col gap-3 font-mono text-sm text-ink-300">
            {items.map((it) => (
              <li key={it.href}>
                <Link
                  href={it.href}
                  onClick={() => setOpen(false)}
                  className="block py-1 hover:text-ink-100"
                >
                  {it.label}
                </Link>
              </li>
            ))}
            <li className="flex items-center gap-2 pt-2">
              <NsfwToggle />
              <span className="text-xs text-ink-500">toggle nsfw</span>
            </li>
          </ul>
        </div>
      ) : null}
    </>
  );
}
