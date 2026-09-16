import withSerwistInit from '@serwist/next';

const withSerwist = withSerwistInit({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  // Service workers in dev cache stale assets and fight HMR; only enable on
  // builds. The installed SW stays deactivated locally until next build.
  disable: process.env.NODE_ENV === 'development'
});

// Image bytes live on the R2 bucket's public custom domain, so the optimizer's
// allowlist has to name that host. It is read from the same env var the app
// builds every blob_url from, rather than hardcoded, so a bucket or domain
// change is one variable and not a code edit.
//
// If R2_PUBLIC_BASE is absent at BUILD time the allowlist ends up empty and
// next/image refuses remote URLs. That is a loud failure rather than a silent
// one, and it only reaches three components: the gallery itself renders bare
// <img> against the derivative ladder and does not go through the optimizer.
const r2Hostname = (() => {
  const base = process.env.R2_PUBLIC_BASE;
  if (!base) return null;
  try {
    return new URL(base).hostname;
  } catch {
    return null;
  }
})();

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: r2Hostname ? [{ protocol: 'https', hostname: r2Hostname }] : []
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

export default withSerwist(nextConfig);
