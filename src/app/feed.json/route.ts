import { NextResponse } from 'next/server';
import { listActiveImagesNewest, getOwnerHandlesForImages } from '@/lib/db/queries/images';
import { SITE_NAME, SITE_URL, DEFAULT_DESCRIPTION, absoluteUrl } from '@/lib/site';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// JSON Feed v1.1 -- https://www.jsonfeed.org/version/1.1/
// Picked over RSS because it's a JSON object (no XML escaping
// landmines) and the major readers (NetNewsWire, Feedbin, FreshRSS,
// Inoreader, Are.na's importers) all parse it.
// Readers fetch the top of the feed; archivists want the whole collection. A
// hard 50 meant the back catalogue simply wasn't syndicable, so the feed now
// pages: `?page=N` walks back through the archive and emits JSON Feed's
// `next_url` so a crawler can follow it to the end on its own.
// Default stays 50 so existing subscribers see an unchanged first page.
// MAX is 99 rather than a round number because listImages clamps `limit` to
// 100 and we fetch pageSize + 1 to look ahead for another page.
const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 99;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const pageRaw = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const sizeRaw = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
  const pageSize =
    Number.isFinite(sizeRaw) && sizeRaw > 0 ? Math.min(sizeRaw, MAX_PAGE_SIZE) : PAGE_SIZE;

  let items: Awaited<ReturnType<typeof listActiveImagesNewest>> = [];
  try {
    // Fetch one extra row to detect "there is another page" without a count query.
    // listActiveImagesNewest, not listImages: paging the whole back catalogue
    // means archived and basement rows would otherwise resurface here.
    items = await listActiveImagesNewest({
      limit: pageSize + 1,
      offset: (page - 1) * pageSize,
      nsfwMode: 'hide'
    });
  } catch (err) {
    console.error('feed.json failed to load images', err);
    return NextResponse.json(
      { error: 'feed temporarily unavailable' },
      { status: 503 }
    );
  }

  // Drop the lookahead row before rendering; its only job was to tell us
  // whether a further page exists.
  const hasMore = items.length > pageSize;
  if (hasMore) items = items.slice(0, pageSize);

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
    }),
    // JSON Feed 1.1 pagination. Readers that only take the first page are
    // unaffected; anything walking the archive follows this to the end.
    ...(hasMore
      ? { next_url: absoluteUrl(`/feed.json?page=${page + 1}&limit=${pageSize}`) }
      : {})
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
