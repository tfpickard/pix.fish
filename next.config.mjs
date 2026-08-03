import withSerwistInit from '@serwist/next';
import { withBotId } from 'botid/next/config';

const withSerwist = withSerwistInit({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  // Service workers in dev cache stale assets and fight HMR; only enable on
  // builds. The installed SW stays deactivated locally until next build.
  disable: process.env.NODE_ENV === 'development'
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '*.public.blob.vercel-storage.com' },
      { protocol: 'https', hostname: '*.blob.vercel-storage.com' }
    ]
  },
  async rewrites() {
    // `/random` is a public-friendly alias for the canonical `/api/random`
    // surface. The bare `/random` serves the random image bytes (the expected
    // browser entry point -- hitting it renders a picture); the JSON record
    // stays at `/api/random` and `/random/data`. Sub-paths map 1:1 to
    // `/api/random/*`. beforeFiles runs before filesystem/dynamic routing, so
    // `/random` wins over the top-level dynamic `[slug]` page instead of being
    // swallowed by it.
    return {
      // The subpath rule uses `:path+` (one-OR-MORE segments) rather than
      // `:path*` (zero-or-more) so it can never match the bare `/random` -- only
      // the explicit rule above handles that, keeping the bare alias on the image
      // bytes rather than the JSON record.
      beforeFiles: [
        { source: '/random', destination: '/api/random/image' },
        { source: '/random/:path+', destination: '/api/random/:path+' }
      ]
    };
  },
  experimental: {
    serverActions: { bodySizeLimit: '20mb' },
    // Next 14.2 defaults `staleTimes.dynamic` to 0, which makes a prefetched
    // dynamic route stale the instant it lands -- any in-viewport <Link> to a
    // `force-dynamic` page then re-prefetches in a loop. We already set
    // prefetch={false} on the nav links (the observed `--` GET / storm), this
    // is defense-in-depth so any other dynamic <Link> (image cards, etc) caches
    // its prefetch for 30s instead of churning.
    staleTimes: { dynamic: 30, static: 180 }
  }
};

// withBotId injects the rewrites that proxy its challenge script from our own
// origin (loading it cross-origin is what ad blockers and CSP break). It wraps
// the already-Serwist-wrapped config rather than the bare one so it sees the
// final rewrite set and merges into it -- the `/random` aliases above are
// beforeFiles rules and must survive. `bun run build` writes the merged list to
// .next/routes-manifest.json; check there if a rewrite ever goes missing.
export default withBotId(withSerwist(nextConfig));
