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
    serverActions: { bodySizeLimit: '20mb' }
  }
};

export default withSerwist(nextConfig);
