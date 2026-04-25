import type { Metadata } from 'next';
import Link from 'next/link';
import { auth, isSiteAdmin } from '@/lib/auth';
import { redirect } from 'next/navigation';

// Belt-and-suspenders: middleware redirects unauthenticated hits, robots.txt
// disallows the path, and this metadata layer adds an in-page noindex in case
// a subpath ever leaks past the other two gates.
export const metadata: Metadata = {
  robots: { index: false, follow: false }
};

// Per-user admin pages: any signed-in user can reach them. The page itself
// scopes its data to session.user.id (uploads, own gallery, own keys, etc.).
const USER_NAV = [
  { href: '/admin/upload', label: 'upload' },
  { href: '/admin/keys', label: 'keys' }
];

// Site-admin platform pages. Each page self-gates with isSiteAdmin() so a
// non-admin who hand-types the URL gets 403'd at the route handler. The
// sidebar still hides these to avoid surfacing them in the UI.
const ADMIN_NAV = [
  { href: '/admin/about', label: 'about' },
  { href: '/admin/gallery', label: 'gallery' },
  { href: '/admin/comments', label: 'comments' },
  { href: '/admin/prompts', label: 'prompts' },
  { href: '/admin/saved-prompts', label: 'saved-prompts' },
  { href: '/admin/taxonomy', label: 'taxonomy' },
  { href: '/admin/ai', label: 'ai' },
  { href: '/admin/reprocess', label: 'reprocess' },
  { href: '/admin/webhooks', label: 'webhooks' },
  { href: '/admin/jobs', label: 'jobs' },
  { href: '/admin/map', label: 'map' },
  { href: '/admin/stats', label: 'stats' },
  { href: '/admin/backup', label: 'backup' }
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session) redirect('/api/auth/signin?callbackUrl=/admin/upload');
  // Phase F: layout no longer redirects non-admins. /admin/upload and
  // /admin/keys are per-user; the platform-config pages self-gate. Admin
  // links are hidden in the sidebar for non-admins so they aren't tempted
  // to click into a 403.
  const admin = isSiteAdmin(session);
  const items = admin ? [...USER_NAV, ...ADMIN_NAV] : USER_NAV;

  return (
    <div className="flex gap-8 pt-8">
      <aside className="w-40 shrink-0 border-r border-ink-800/60 pr-4">
        <p className="mb-3 font-mono text-xs uppercase tracking-wider text-ink-500">admin</p>
        <ul className="space-y-1 font-mono text-sm">
          {items.map((item) => (
            <li key={item.href}>
              <Link href={item.href} className="text-ink-400 hover:text-ink-100">
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </aside>
      <div className="flex-1">{children}</div>
    </div>
  );
}
