import Image from 'next/image';
import Link from 'next/link';
import { auth, isOwner } from '@/lib/auth';
import { ThemeToggle } from '@/components/theme-toggle';

export async function NavBar() {
  const session = await auth();
  const owner = isOwner(session);
  return (
    <header className="sticky top-0 z-40 border-b border-ink-800/60 bg-ink-950/80 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4">
        <Link href="/" className="flex shrink-0 items-center gap-2 font-fungal text-2xl leading-none">
          <Image
            src="/logo-dark.png"
            alt=""
            width={28}
            height={28}
            priority
            className="logo-for-dark h-7 w-7 rounded-full"
          />
          <Image
            src="/logo-light.png"
            alt=""
            width={28}
            height={28}
            priority
            className="logo-for-light h-7 w-7 rounded-full"
          />
          <span>
            <span className="text-secondary">pix</span>
            <span className="text-primary">.</span>
            <span className="text-ink-100">fish</span>
          </span>
        </Link>
        <form action="/search" method="GET" className="ml-auto flex-1 max-w-xs">
          <input
            type="search"
            name="q"
            placeholder="search semantically..."
            className="w-full rounded-md border border-ink-800 bg-ink-950/60 px-3 py-1.5 font-mono text-xs text-ink-100 placeholder:text-ink-500 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/30"
            aria-label="search"
          />
        </form>
        <nav className="flex items-center gap-4 font-mono text-xs text-ink-400">
          <Link href="/" className="hover:text-ink-100 transition-colors">
            gallery
          </Link>
          {owner ? (
            <Link href="/admin/upload" className="hover:text-ink-100 transition-colors">
              upload
            </Link>
          ) : null}
          {session ? (
            <Link href="/api/auth/signout" className="hover:text-ink-100 transition-colors">
              sign out
            </Link>
          ) : (
            <Link href="/api/auth/signin" className="hover:text-ink-100 transition-colors">
              sign in
            </Link>
          )}
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
