'use client';

import Link from 'next/link';
import { ChevronDown, Menu, X } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
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

  // The exploratory surfaces (the ways to wander the corpus) collapse into a
  // single "explore" dropdown so the top-level row stays short no matter how
  // many we add. New visualization/feed routes go here, not in the flat row.
  const explore: NavItem[] = [
    { href: '/map', label: 'atlas' },
    { href: '/manifold', label: 'manifold' },
    { href: '/connect', label: 'connect' },
    { href: '/daily', label: 'daily' },
    { href: '/taste', label: 'taste' },
    { href: '/drift', label: 'drift' },
    { href: '/chronicle', label: 'chronicle' }
  ];

  // Always-visible primary destinations, shown inline at md+ on either side of
  // the explore menu.
  const primary: NavItem[] = [
    { href: '/search', label: 'search' },
    { href: '/about', label: 'about' },
    ...(signedIn ? [{ href: '/admin/upload', label: 'upload' }] : []),
    ...(handle ? [{ href: `/u/${handle}`, label: `/u/${handle}` }] : []),
    ...(admin ? [{ href: '/admin/ai', label: 'admin' }] : []),
    {
      href: authed ? '/api/auth/signout' : '/api/auth/signin',
      label: authed ? 'sign out' : 'sign in'
    }
  ];

  // Flat list for the mobile popover -- there the vertical layout has room, so
  // everything is shown without the dropdown.
  const allItems: NavItem[] = [{ href: '/', label: 'gallery' }, ...explore, ...primary];

  return (
    <>
      {/* Inline at md+: gallery, an explore dropdown, then the primary links. */}
      <nav className="hidden items-center gap-4 font-mono text-xs text-ink-400 md:flex">
        {/* prefetch={false}: these targets are `force-dynamic`, so the whole
            row sitting in the viewport at the top of every page would otherwise
            re-prefetch on a loop under Next 14.2's `staleTimes.dynamic: 0`
            default -- that was the `--` GET / request storm. See nav-bar.tsx. */}
        <Link href="/" prefetch={false} className="transition-colors hover:text-ink-100">
          gallery
        </Link>
        <ExploreMenu items={explore} pathname={pathname} />
        {primary.map((it) => (
          <Link key={it.href} href={it.href} prefetch={false} className="transition-colors hover:text-ink-100">
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
            {allItems.map((it) => (
              <li key={it.href}>
                <Link
                  href={it.href}
                  prefetch={false}
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

// Inline "explore" dropdown for the md+ row. Click to toggle; closes on
// outside-click, Escape, route change, or selecting a link. Keeps the primary
// nav row short as exploratory surfaces accumulate.
function ExploreMenu({ items, pathname }: { items: NavItem[]; pathname: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  // Match the current route to a nav item, including nested pages (e.g.
  // /taste/popular highlights /taste), so the trigger + item highlight on
  // sub-routes too.
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const active = items.some((it) => isActive(it.href));

  // Close on route change.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Close on outside click / Escape while open. Listen for `click` rather than
  // `mousedown` so touch-only pointers behave consistently. Clicks inside the
  // wrapper (the trigger + the menu) are ignored, so the toggle still works.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('click', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((p) => !p)}
        className={`flex items-center gap-0.5 transition-colors hover:text-ink-100 ${active ? 'text-ink-100' : ''}`}
      >
        explore
        <ChevronDown size={12} strokeWidth={1.75} className={open ? 'rotate-180' : ''} />
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute left-0 top-6 z-30 min-w-[8rem] rounded border border-ink-800/60 bg-ink-950/95 py-1 backdrop-blur"
        >
          {items.map((it) => (
            <Link
              key={it.href}
              href={it.href}
              prefetch={false}
              role="menuitem"
              onClick={() => setOpen(false)}
              className={`block px-3 py-1.5 transition-colors hover:text-ink-100 ${isActive(it.href) ? 'text-ink-100' : 'text-ink-400'}`}
            >
              {it.label}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
