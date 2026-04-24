import type { ImageWithRelations } from '@/lib/db/queries/images';
import type { Comment } from '@/lib/db/schema';
import { absoluteUrl, SITE_NAME, SITE_URL, DEFAULT_DESCRIPTION } from '@/lib/site';
import {
  buildImageTitle,
  buildImageDescription,
  buildImageKeywords
} from '@/lib/seo/image-meta';

type JsonLd = Record<string, unknown>;

// Pure builders: no React, no DOM. Callers stringify + inject via a
// <script type="application/ld+json"> tag. Keeping them pure means the same
// shape can be reused from route handlers, RSS feeds, or tests.

export function buildImageObjectLd(
  img: ImageWithRelations,
  opts: { comments?: Comment[] } = {}
): JsonLd {
  const pageUrl = absoluteUrl('/' + img.slug);
  const name = buildImageTitle(img);
  const description = buildImageDescription(img);
  const keywords = buildImageKeywords(img);

  // `exif` is `jsonb` -- narrow it defensively so a row with unexpected JSON
  // doesn't blow up the page render.
  const exifTakenAt = readStringField(img.exif, 'takenAt') ?? readStringField(img.exif, 'DateTimeOriginal');
  const datePublished = img.takenAt?.toISOString() ?? exifTakenAt ?? img.uploadedAt.toISOString();

  const base: JsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ImageObject',
    '@id': pageUrl + '#image',
    url: pageUrl,
    contentUrl: img.blobUrl,
    thumbnailUrl: img.blobUrl,
    name,
    description,
    keywords: keywords.join(', '),
    uploadDate: img.uploadedAt.toISOString(),
    datePublished,
    creator: {
      '@type': 'Person',
      name: 'Tom Pickard',
      url: SITE_URL
    },
    // Explicit license hook: the about page carries the human-readable version,
    // and the schema.org field points crawlers at it. Owner can swap in a real
    // CC or custom URL later without touching code.
    license: absoluteUrl('/about#license'),
    acquireLicensePage: absoluteUrl('/about#license')
  };

  if (img.width) base.width = img.width;
  if (img.height) base.height = img.height;

  const approved = (opts.comments ?? []).filter((c) => c.status === 'approved');
  if (approved.length > 0) {
    base.commentCount = approved.length;
    base.comment = approved.map((c) => ({
      '@type': 'Comment',
      text: c.body,
      author: { '@type': 'Person', name: c.authorName || 'anonymous' },
      dateCreated: c.createdAt.toISOString()
    }));
  }

  return base;
}

// Rich Results Test rejects an ItemList when numberOfItems disagrees with
// the actual element count, so the cap is applied before the count is derived.
const COLLECTION_ITEM_CAP = 30;

export function buildCollectionPageLd(images: ImageWithRelations[]): JsonLd {
  const items = images.slice(0, COLLECTION_ITEM_CAP);
  return {
    '@context': 'https://schema.org',
    '@type': 'CollectionPage',
    '@id': SITE_URL + '#collection',
    url: SITE_URL,
    name: SITE_NAME,
    description: DEFAULT_DESCRIPTION,
    isPartOf: { '@type': 'WebSite', '@id': SITE_URL + '#website', url: SITE_URL, name: SITE_NAME },
    mainEntity: {
      '@type': 'ItemList',
      numberOfItems: items.length,
      itemListElement: items.map((img, idx) => ({
        '@type': 'ListItem',
        position: idx + 1,
        url: absoluteUrl('/' + img.slug),
        item: {
          '@type': 'ImageObject',
          '@id': absoluteUrl('/' + img.slug) + '#image',
          url: absoluteUrl('/' + img.slug),
          contentUrl: img.blobUrl,
          name: buildImageTitle(img)
        }
      }))
    }
  };
}

// Emitted from the root layout so every page includes the SearchAction that
// tells Google about the /search?q= sitelinks search box.
export function buildWebSiteLd(): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': SITE_URL + '#website',
    url: SITE_URL,
    name: SITE_NAME,
    description: DEFAULT_DESCRIPTION,
    potentialAction: {
      '@type': 'SearchAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: SITE_URL + '/search?q={search_term_string}'
      },
      // schema.org quirk: this string is non-optional and must be `required name=...`
      'query-input': 'required name=search_term_string'
    }
  };
}

export function buildBreadcrumbLd(items: { name: string; url: string }[]): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      name: item.name,
      item: absoluteUrl(item.url)
    }))
  };
}

function readStringField(obj: unknown, key: string): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : null;
}
