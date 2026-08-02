import { Suspense } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { auth, isSiteAdmin } from '@/lib/auth';
import { NavSearch } from '@/components/nav-search';
import { NavOverflow } from '@/components/nav-overflow';

export async function NavBar() {
  const session = await auth();
  // Phase F: any signed-in user sees `upload`. Site admins additionally
  // get a small `admin` link to the platform-config sidebar.
  const signedIn = !!session?.user?.id || !!session?.user?.githubId;
  const admin = isSiteAdmin(session);
  const handle = session?.user?.handle ?? null;
  // Header is z-50 -- above the z-40 Pisci chat banner. The overflow menu drops
  // down into the banner's zone, so the nav's stacking context must sit above
  // it, or the banner would paint over the first dropdown items and eat their
  // clicks while chat is open.
  return (
    <header className="sticky top-0 z-50 border-b border-ink-800/60 bg-ink-950/80 backdrop-blur">
      <div className="relative mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4">
        {/* prefetch disabled: every nav target is `force-dynamic` (page.tsx,
            map, connect, manifold, search, about, feed), so a speculative
            prefetch caches nothing reusable. Under Next 14.2's default
            `staleTimes.dynamic: 0`, an in-viewport <Link> to such a route
            re-prefetches on a loop -- each `?_rsc=` request cancels the prior
            (the `--` GET / storm in the Vercel logs). Keep prefetch={false} on
            every nav link until these routes stop being force-dynamic. */}
        <Link href="/" prefetch={false} className="flex shrink-0 items-center gap-2 font-fungal text-2xl leading-none">
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
        {/* NavSearch reads useSearchParams. Without a Suspense boundary that
            opts the ENTIRE route out of static rendering and stamps a
            BAILOUT_TO_CLIENT_SIDE_RENDERING marker into the served HTML -- and
            because the nav lives in the root layout, it did so on every page.
            An audit crawler reading that marker reasonably concludes the whole
            gallery is client-rendered. The boundary keeps the bailout local to
            the search box. */}
        <Suspense fallback={null}>
          <NavSearch />
        </Suspense>
        <NavOverflow
          signedIn={signedIn}
          admin={admin}
          handle={handle}
          authed={!!session}
        />
      </div>
    </header>
  );
}
