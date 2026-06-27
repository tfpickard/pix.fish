import withSerwistInit from '@serwist/next';

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
