import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { readBasementCookie } from '@/lib/basement';
import { listBasementImages, countBasementImages } from '@/lib/db/queries/basement';
import { BasementGrid } from '@/components/basement-grid';
import { LockBasementButton } from '@/components/lock-basement-button';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// Deliberately terse metadata -- no description that would hint at what
// this section is from public indexing. robots: noindex keeps it off search.
export const metadata: Metadata = {
  title: 'basement',
  robots: { index: false, follow: false }
};

export default async function BasementPage() {
  // Server-side gate: if the visitor hasn't performed the unlock ritual,
  // this is a 404. Not a 403 -- the route shouldn't advertise it exists.
  const unlocked = await readBasementCookie();
  if (!unlocked) {
    notFound();
  }

  const [images, total] = await Promise.all([
    listBasementImages({ limit: 24 }),
    countBasementImages()
  ]);

  return (
    // Distinct palette: sickly green-on-near-black, not the gallery violet.
    // The hue shift makes it immediately clear you are not in the main gallery
    // without requiring a separate theme toggle or CSS variable override.
    <div className="pt-8">
      <section className="mx-auto max-w-2xl space-y-3">
        <h1 className="font-mono text-2xl tracking-[0.3em] text-[#7fff7f]">
          / basement /
        </h1>
        <p className="font-mono text-xs text-[#4a6e4a]">
          {total} {total === 1 ? 'thing' : 'things'} down here
        </p>
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#2a3e2a]">
          / you found it /
        </p>
      </section>

      <div className="mx-auto mt-8 max-w-2xl">
        <BasementGrid initial={images} total={total} />
      </div>

      {/* Re-lock affordance: discoverable once you are in, not before. */}
      <div className="mx-auto mt-16 max-w-2xl border-t border-[#1a2e1a] pt-6">
        <LockBasementButton />
      </div>
    </div>
  );
}
