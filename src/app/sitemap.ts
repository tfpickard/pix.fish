import type { MetadataRoute } from 'next';
import { listSitemapImages } from '@/lib/db/queries/images';
import { absoluteUrl } from '@/lib/site';

// Only list indexable routes. /search and /map are `noindex` -- including
// them here would trip Search Console's "Submitted URL marked noindex"
// warning on every recrawl.
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();

  const staticEntries: MetadataRoute.Sitemap = [
    { url: absoluteUrl('/'), lastModified: now, changeFrequency: 'daily', priority: 1 },
    { url: absoluteUrl('/about'), lastModified: now, changeFrequency: 'monthly', priority: 0.6 }
  ];

  // Fail soft: a sitemap that 500s is worse than a sitemap that lists only
  // static pages, because some crawlers cache the failure for hours.
  let imageEntries: MetadataRoute.Sitemap = [];
  try {
    const rows = await listSitemapImages();
    imageEntries = rows.map((row) => ({
      // Phase D canonical: /u/<handle>/<slug>. Pre-backfill rows without a
      // resolvable owner handle fall back to legacy /<slug> so the sitemap
      // never emits a path with `null` in it.
      url: absoluteUrl(row.ownerHandle ? `/u/${row.ownerHandle}/${row.slug}` : `/${row.slug}`),
      lastModified: row.uploadedAt,
      changeFrequency: 'monthly' as const,
      priority: 0.8
    }));
  } catch (err) {
    console.error('sitemap: listSitemapImages failed', err);
  }

  return [...staticEntries, ...imageEntries];
}
