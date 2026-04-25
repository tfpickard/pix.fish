// Canonical origin + site-level constants. Everything that emits an absolute
// URL (sitemap, JSON-LD, OG/Twitter cards, canonical tags, feeds) MUST go
// through here so we have one place to change the host.

const FALLBACK_ORIGIN = 'https://pix.fish';

// NEXT_PUBLIC_* so the value is available in client components too. We strip
// a trailing slash so callers can compose `${SITE_URL}${path}` without doubling.
export const SITE_URL: string = (process.env.NEXT_PUBLIC_SITE_URL ?? FALLBACK_ORIGIN).replace(/\/+$/, '');

export const SITE_NAME = 'pix.fish';

// ~155 chars -- the upper bound Google typically shows in SERP snippets. The
// framing intentionally says "photography" and "AI-captioned" so the default
// description actually carries keywords instead of restating the domain.
export const DEFAULT_DESCRIPTION =
  'pix.fish is a single-owner photography gallery with AI-captioned images, semantic search, color palettes, and a tag taxonomy for discovering photos.';

export function absoluteUrl(path: string): string {
  if (!path) return SITE_URL;
  if (/^https?:\/\//i.test(path)) return path;
  return SITE_URL + (path.startsWith('/') ? path : '/' + path);
}
