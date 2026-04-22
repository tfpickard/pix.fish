import Link from 'next/link';
import { auth, isOwner } from '@/lib/auth';

export async function NavBar() {
  const session = await auth();
  const owner = isOwner(session);
  return (
    <header className="sticky top-0 z-40 border-b border-ink-800/60 bg-ink-950/80 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4">
        <Link
          href="/"
          className="font-display text-xl tracking-tight text-ink-100 hover:text-white"
        >
          pix<span className="text-ink-500">.</span>fish
        </Link>
        <nav className="flex items-center gap-4 font-mono text-xs text-ink-400">
          <Link href="/" className="hover:text-ink-100">
            gallery
          </Link>
          {owner ? (
            <Link href="/admin/upload" className="hover:text-ink-100">
              upload
            </Link>
          ) : null}
          {session ? (
            <Link href="/api/auth/signout" className="hover:text-ink-100">
              sign out
            </Link>
          ) : (
            <Link href="/api/auth/signin" className="hover:text-ink-100">
              sign in
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}
