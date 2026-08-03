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
// JPEG, not PNG. @vercel/og only emits PNG, which is a poor fit for this work:
// dense pen-and-ink hatching is effectively photographic noise, so a 1200x630
// PNG of a typical specimen lands around 1.3 MB. Re-encoding to JPEG takes the
// same card to a couple hundred KB with no visible loss at card size -- which
// matters, because shrinking what a share actually pushes over the wire is the
// entire point of this file.
export const OG_CONTENT_TYPE = 'image/jpeg';
const JPEG_QUALITY = 86;

// Not `immutable`. The card is rendered from mutable rows: PATCH /api/images/
// [slug] can rewrite the text of the slug-source caption without changing the
// slug, so the same URL legitimately renders different art. A year of
// immutable would pin the old card until the cache aged out. These numbers
// still keep the expensive part (blob fetch + Satori + JPEG encode) off the
// hot path -- the edge serves stale while it refreshes behind the request.
const CARD_CACHE_CONTROL = 'public, no-transform, max-age=300, s-maxage=3600, stale-while-revalidate=86400';

// Cards are read by scrapers, not humans scrolling -- a long flat caption is
// the joke, but it still has to fit. Trim on a word boundary.
function fitCaption(text: string, max = 150): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}

export async function renderOgCard(opts: {
  imageUrl: string;
  caption: string;
}): Promise<Response> {
  const png = renderPng(opts);

  // Best-effort re-encode. sharp is already a dependency (the derive.image job
  // uses it) and this route runs on the nodejs runtime, but if anything goes
  // wrong we still want to serve a valid card -- so fall back to the PNG rather
  // than 500 on a share.
  try {
    const sharp = (await import('sharp')).default;
    const buf = Buffer.from(await png.arrayBuffer());
    const jpeg = await sharp(buf).jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();
    return new Response(new Uint8Array(jpeg), {
      headers: { 'content-type': OG_CONTENT_TYPE, 'cache-control': CARD_CACHE_CONTROL }
    });
  } catch (err) {
    console.error('og-card: jpeg re-encode failed, serving png', err);
    // The route files export contentType = OG_CONTENT_TYPE, which Next emits as
    // og:image:type -- so on this path the advisory metadata says jpeg while the
    // bytes are png. Harmless, and deliberately preferred over the alternatives:
    // declaring png would mislabel every card for one rare failure, and hard-
    // failing would serve no card at all. Every consumer that matters sniffs the
    // magic bytes or trusts the response header, both of which stay truthful --
    // ImageResponse sets content-type: image/png itself. We only override
    // cache-control, so a degraded card cannot outlive the failure it came from.
    png.headers.set('cache-control', CARD_CACHE_CONTROL);
    return png;
  }
}

function renderPng(opts: { imageUrl: string; caption: string }): ImageResponse {
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
            (the small absurd detail is often at an edge).

            Rendered ONLY when we have a URL. Satori throws "Image source is not
            provided" on an empty src rather than skipping the element, which
            turned the not-found fallback into a 500 -- so a bad slug served no
            card at all, which is exactly when a card matters most. */}
        {opts.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={opts.imageUrl}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
        ) : null}

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
