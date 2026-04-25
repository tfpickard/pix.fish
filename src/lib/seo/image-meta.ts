import type { ImageWithRelations } from '@/lib/db/queries/images';

// The page body picks a random caption/description per render (intentional UX
// from `src/app/[slug]/page.tsx`). Crawlers need a STABLE title per URL, so
// metadata paths call the helpers below instead of `pickOne()`. The slug-source
// caption is the one marked `isSlugSource=true` at upload time -- the same
// caption the URL itself is derived from.

export function pickSlugCaption(img: Pick<ImageWithRelations, 'captions' | 'manualCaption' | 'slug'>): string {
  if (img.manualCaption && img.manualCaption.trim().length > 0) return img.manualCaption;
  const sourceCaption = img.captions.find((c) => c.isSlugSource);
  if (sourceCaption) return sourceCaption.text;
  const first = img.captions[0];
  return first?.text ?? img.slug;
}

export function pickCanonicalDescription(img: Pick<ImageWithRelations, 'descriptions'>): string {
  const first = img.descriptions[0];
  return first?.text ?? '';
}

// Truncate on a word boundary if possible. Targets Google's ~60-char title
// cutoff; anything longer gets trailed with an ellipsis character.
export function buildImageTitle(img: Pick<ImageWithRelations, 'captions' | 'manualCaption' | 'slug'>, max = 60): string {
  return truncate(pickSlugCaption(img), max);
}

export function buildImageDescription(
  img: Pick<ImageWithRelations, 'descriptions' | 'captions' | 'manualCaption' | 'slug'>,
  max = 160
): string {
  const desc = pickCanonicalDescription(img);
  if (desc) return truncate(desc, max);
  // Fall back to the caption if no description exists yet -- better than an
  // empty meta description.
  return truncate(pickSlugCaption(img), max);
}

export function buildImageKeywords(img: Pick<ImageWithRelations, 'tags'>, limit = 10): string[] {
  return img.tags.slice(0, limit).map((t) => t.tag);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > max * 0.6) return cut.slice(0, lastSpace).trimEnd() + '…';
  return cut.trimEnd() + '…';
}
