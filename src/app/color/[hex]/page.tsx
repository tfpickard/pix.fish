import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ImageGrid } from '@/components/image-grid';
import { listImagesByPaletteHex, normalizeHex } from '@/lib/db/queries/palette';
import { readShowNsfwCookie } from '@/lib/nsfw';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Single-color landing page reachable from clicking a palette swatch on
// any image detail. Lists images whose dominant palette includes a hex
// within a small RGB threshold of the target.
export const metadata: Metadata = {
  title: 'color',
  robots: { index: false, follow: true }
};

type Params = { hex: string };

export default async function ColorPage({ params }: { params: Params }) {
  // Next already URL-decodes route params, so a malformed segment like
  // `/color/%` would throw at the framework boundary, not here. We only
  // need to coerce a six-hex string into a normalized #aabbcc.
  const raw = params.hex;
  const normalized = normalizeHex(raw.startsWith('#') ? raw : `#${raw}`);
  if (!normalized) notFound();
  // Respect the visitor's site-wide NSFW preference (cookie). Without
  // this, the palette filter would surface NSFW rows even to a default-
  // hide visitor and bypass the same gating used everywhere else.
  const includeNsfw = await readShowNsfwCookie();
  const matches = await listImagesByPaletteHex(normalized, {
    limit: 60,
    includeNsfw
  }).catch(() => []);

  return (
    <div className="space-y-6 pt-8">
      <section className="space-y-3">
        <h1 className="font-fungal-lite text-3xl text-ink-100">color</h1>
        <div className="flex items-center gap-3">
          <span
            className="block h-8 w-8 rounded border border-ink-800"
            style={{ backgroundColor: normalized }}
            aria-hidden
          />
          <p className="font-mono text-xs text-ink-500">
            {normalized} &middot; {matches.length} {matches.length === 1 ? 'image' : 'images'}
          </p>
        </div>
      </section>
      <ImageGrid images={matches} />
    </div>
  );
}
