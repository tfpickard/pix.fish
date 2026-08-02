// Canonical origin + site-level constants. Everything that emits an absolute
// URL (sitemap, JSON-LD, OG/Twitter cards, canonical tags, feeds) MUST go
// through here so we have one place to change the host.

const FALLBACK_ORIGIN = 'https://pix.fish';

// NEXT_PUBLIC_* so the value is available in client components too. We strip
// a trailing slash so callers can compose `${SITE_URL}${path}` without doubling.
export const SITE_URL: string = (process.env.NEXT_PUBLIC_SITE_URL ?? FALLBACK_ORIGIN).replace(/\/+$/, '');

export const SITE_NAME = 'pix.fish';

// ~155 chars -- the upper bound Google typically shows in SERP snippets. This
// is the single most-repeated sentence on the site: it is the SERP snippet, the
// feed description, and the fallback share card, so it is worth writing rather
// than inventorying.
//
// The previous version ("a single-owner photography gallery with AI-captioned
// images, semantic search, color palettes, and a tag taxonomy") described the
// plumbing, and by now described it wrongly: the gallery is multi-user, and the
// work is surrealist illustration, not photography. It also sold a distinctive
// voice as generic infrastructure -- for an art project the moat is the voice.
//
// This one speaks in the archive's own register (see CLERK_ROSTER and the
// character/dossier prompts: specimens are catalogued and cross-referenced by
// clerks who openly disagree) while still carrying the terms worth ranking on.
export const DEFAULT_DESCRIPTION =
  'An unreliable bureaucratic archive of surreal images. Every specimen is catalogued, captioned and cross-referenced by clerks who disagree on what it is.';

export function absoluteUrl(path: string): string {
  if (!path) return SITE_URL;
  if (/^https?:\/\//i.test(path)) return path;
  return SITE_URL + (path.startsWith('/') ? path : '/' + path);
}
