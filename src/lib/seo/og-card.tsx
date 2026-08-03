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
//  - The source is normalized through sharp before Satori sees it, rather than
//    handed over as-is. See loadSource() -- uploads accept formats Satori
//    cannot decode, and that failure is not recoverable downstream.
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

// A card that does not contain the artwork gets minutes, not hours, and no
// stale-while-revalidate (which would extend the poison window by a day).
//
// Every route into that state is potentially transient: the detail routes turn
// a failed lookup into the not-found card, and loadSource() turns a blob blip
// into a text-only one. Caching those like a real render lets a scraper that
// happened to arrive during a thirty-second outage hold a broken card long
// after the dependency recovered. A genuine 404 is graded the same way -- it
// costs one cheap 8 KB re-render to avoid needing to tell the two apart, and
// a slug that 404s today can exist tomorrow.
const DEGRADED_CACHE_CONTROL = 'public, no-transform, max-age=60, s-maxage=60';

// Cards are read by scrapers, not humans scrolling -- a long flat caption is
// the joke, but it still has to fit. Trim on a word boundary.
function fitCaption(text: string, max = 150): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}...`;
}

function cardResponse(bytes: Buffer, contentType: string, degraded: boolean): Response {
  return new Response(new Uint8Array(bytes), {
    headers: {
      'content-type': contentType,
      'cache-control': degraded ? DEGRADED_CACHE_CONTROL : CARD_CACHE_CONTROL
    }
  });
}

// Satori decodes PNG/JPEG/GIF but not WebP, and the upload route accepts
// image/webp (ALLOWED_MIME in api/images/route.ts). Handing it a WebP blob
// throws during render, and nothing downstream can repair that -- the JPEG
// re-encode below only ever sees a card that already rendered. So normalize
// first: fetch the original, let sharp transcode and shrink it to the frame,
// and give Satori a data URI it is guaranteed to understand.
//
// Resizing here is not incidental. Satori otherwise decodes the full original
// (one measured at 3.4 MB) just to draw it at 1200x630.
//
// Returns null rather than throwing on any failure, which renders the
// text-only card. A card with no picture still carries the caption, the name
// and the frame; a throw here would 500 the route and yield no card at all.
async function loadSource(url: string): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`blob fetch ${res.status}`);
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp(Buffer.from(await res.arrayBuffer()))
      .resize(OG_SIZE.width, OG_SIZE.height, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  } catch (err) {
    console.error('og-card: source unusable, rendering text-only card', url, err);
    return null;
  }
}

export async function renderOgCard(opts: {
  imageUrl: string;
  caption: string;
}): Promise<Response> {
  const source = await loadSource(opts.imageUrl);
  // A card is fully cacheable only if it actually carries the artwork. That
  // one rule covers every degraded path -- missing row, failed lookup, dead
  // blob, undecodable source -- without the route having to classify which.
  const degraded = source === null;

  // Buffer the Satori output ONCE, before the re-encode can fail. Reading an
  // ImageResponse consumes its body, so the obvious shape -- read inside the
  // try, hand the same object back from the catch -- returns a response with
  // bodyUsed already true. The fallback that exists so a share never breaks
  // was itself serving an unreadable body, and only on the path where it was
  // the last line of defense.
  const pngBytes = Buffer.from(await renderPng({ ...opts, imageUrl: source }).arrayBuffer());

  // sharp is already a dependency (the derive.image job uses it) and these
  // routes run on the nodejs runtime, so this should not fail -- but a card is
  // worth serving in the wrong format, and not worth 500ing over.
  try {
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp(pngBytes).jpeg({ quality: JPEG_QUALITY, mozjpeg: true }).toBuffer();
    return cardResponse(jpeg, OG_CONTENT_TYPE, degraded);
  } catch (err) {
    console.error('og-card: jpeg re-encode failed, serving png', err);
    // The route files export contentType = OG_CONTENT_TYPE, which Next emits as
    // og:image:type, so this path's advisory metadata says jpeg while the bytes
    // are png. Deliberate: declaring png would mislabel every card to be honest
    // about a rare one. What consumers actually read -- the response header set
    // just below, and the magic bytes -- stays truthful. Graded degraded too:
    // a card in the wrong format should not outlive the failure that caused it.
    return cardResponse(pngBytes, 'image/png', true);
  }
}

function renderPng(opts: { imageUrl: string | null; caption: string }): ImageResponse {
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
