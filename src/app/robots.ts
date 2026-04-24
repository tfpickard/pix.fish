import type { MetadataRoute } from 'next';
import { absoluteUrl } from '@/lib/site';

// Crawlers cost crawl budget. Admin + mutation APIs are already auth-gated,
// but disallowing them explicitly keeps bots from wasting hits on pages that
// will 302 or 403. /api/auth/* is disallowed too so we don't leak provider
// callback URLs into crawl indexes.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/admin', '/admin/', '/api/']
      }
    ],
    sitemap: absoluteUrl('/sitemap.xml')
  };
}
