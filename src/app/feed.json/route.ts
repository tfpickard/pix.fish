import { NextResponse } from 'next/server';
import { listImages, getOwnerHandlesForImages } from '@/lib/db/queries/images';
import { SITE_NAME, SITE_URL, DEFAULT_DESCRIPTION, absoluteUrl } from '@/lib/site';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// JSON Feed v1.1 -- https://www.jsonfeed.org/version/1.1/
// Picked over RSS because it's a JSON object (no XML escaping
// landmines) and the major readers (NetNewsWire, Feedbin, FreshRSS,
// Inoreader, Are.na's importers) all parse it.
export async function GET() {
  let items: Awaited<ReturnType<typeof listImages>> = [];
  try {
    items = await listImages({ limit: 50, sort: 'newest', includeNsfw: false });
  } catch (err) {
    console.error('feed.json failed to load images', err);
    return NextResponse.json(
      { error: 'feed temporarily unavailable' },
      { status: 503 }
    );
  }

  const handles = await getOwnerHandlesForImages(items.map((i) => i.id)).catch(
    () => new Map<number, string>()
  );

  const feed = {
    version: 'https://jsonfeed.org/version/1.1',
    title: SITE_NAME,
    home_page_url: SITE_URL,
    feed_url: absoluteUrl('/feed.json'),
    description: DEFAULT_DESCRIPTION,
    icon: absoluteUrl('/icons/apple-touch-icon.png'),
    favicon: absoluteUrl('/favicon.ico'),
    items: items.map((img) => {
      const caption = img.captions[0]?.text ?? img.slug;
      const description = img.descriptions[0]?.text ?? '';
      const handle = handles.get(img.id);
      const path = handle ? `/u/${handle}/${img.slug}` : `/${img.slug}`;
      const url = absoluteUrl(path);
      return {
        id: url,
        url,
        title: caption,
        content_html: `<p>${escapeHtml(caption)}</p>${
          description ? `<p>${escapeHtml(description)}</p>` : ''
        }<p><img src="${escapeAttr(img.blobUrl)}" alt="${escapeAttr(caption)}" /></p>`,
        date_published: (img.takenAt ?? img.uploadedAt).toISOString(),
        date_modified: img.uploadedAt.toISOString(),
        tags: img.tags.map((t) => t.tag),
        image: img.blobUrl,
        attachments: [
          {
            url: img.blobUrl,
            mime_type: img.mime ?? 'image/jpeg'
          }
        ]
      };
    })
  };

  return NextResponse.json(feed, {
    headers: {
      'content-type': 'application/feed+json; charset=utf-8',
      'cache-control': 'public, max-age=300, s-maxage=300'
    }
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
