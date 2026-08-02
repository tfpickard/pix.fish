import { ImageResponse } from 'next/og';
import { SITE_NAME } from '@/lib/site';

// Purpose-built 1200x630 social card, shared by the opengraph-image routes for
// /u/[handle]/[slug] and legacy /[slug].
//
// Why this exists: og:image used to point straight at the original blob -- one
// measured at 3.4 MB of PNG -- while *declaring* 1200x630 because images.width/
// height are never populated. So every paste into Slack/iMessage/Discord pulled
// multiple megabytes, unfurled slowly, framed unpredictably, and sat over some
// scrapers' size limits. Sharing is the action that spreads a gallery, so the
// card sitting on it is load-bearing.
//
// Two deliberate constraints:
//  - Source is the ORIGINAL blob, not a WebP derivative. Satori's image
//    decoding is reliable for PNG/JPEG but not WebP, and the heavy fetch is
//    server-side and cached -- the visitor only ever receives the ~1200x630
//    output, which is the byte win we actually care about.
//  - No custom face. The only local font is FungalVF.woff2 and Satori cannot
//    parse woff2, so loading it would fail at runtime. Identity comes from the
//    ink palette and layout instead of a font that would not render.
export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = 'image/png';

// Cards are read by scrapers, not humans scrolling -- a long flat caption is
// the joke, but it still has to fit. Trim on a word boundary.
function fitCaption(text: string, max = 150): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}

export function renderOgCard(opts: { imageUrl: string; caption: string }): ImageResponse {
  const caption = fitCaption(opts.caption);

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          position: 'relative',
          backgroundColor: '#0a0a0b',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        {/* The work itself, contained rather than cropped: these are composed
            surrealist frames and a center-crop routinely cuts the punchline
            (the small absurd detail is often at an edge). */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={opts.imageUrl}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
        />

        {/* Caption strip. Sits over the letterbox rather than stealing frame
            from the image, and stays legible on a light or dark picture. */}
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 24,
            padding: '28px 40px 26px',
            background: 'linear-gradient(to top, rgba(10,10,11,0.94) 0%, rgba(10,10,11,0) 100%)'
          }}
        >
          <div
            style={{
              display: 'flex',
              fontSize: 26,
              lineHeight: 1.35,
              color: '#e8e8ea',
              maxWidth: 900
            }}
          >
            {caption}
          </div>
          <div
            style={{
              display: 'flex',
              fontSize: 20,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: '#6f6f78',
              whiteSpace: 'nowrap'
            }}
          >
            {SITE_NAME}
          </div>
        </div>
      </div>
    ),
    OG_SIZE
  );
}
