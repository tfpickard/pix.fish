import Link from 'next/link';
import { auth, isOwner } from '@/lib/auth';
import { redirect } from 'next/navigation';

const NAV = [
  { href: '/admin/upload', label: 'upload' },
  { href: '/admin/about', label: 'about' },
  { href: '/admin/comments', label: 'comments' },
  { href: '/admin/prompts', label: 'prompts' },
  { href: '/admin/saved-prompts', label: 'saved-prompts' },
  { href: '/admin/taxonomy', label: 'taxonomy' },
  { href: '/admin/keys', label: 'keys' },
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
  if (!isOwner(session)) redirect('/');

  return (
    <div className="flex gap-8 pt-8">
      <aside className="w-40 shrink-0 border-r border-ink-800/60 pr-4">
        <p className="mb-3 font-mono text-xs uppercase tracking-wider text-ink-500">admin</p>
        <ul className="space-y-1 font-mono text-sm">
          {NAV.map((item) => (
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
