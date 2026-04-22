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

export default nextConfig;
