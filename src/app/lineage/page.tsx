import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { auth, isSiteAdmin } from '@/lib/auth';
import { getGalleryDefaults } from '@/lib/db/queries/gallery-config';
import { getSiteAdminId } from '@/lib/db/queries/users';
import { getLineageGraph } from '@/lib/db/queries/lineage';
import { LineageGraph } from '@/components/lineage-graph';
import { LineageVisibilityToggle } from '@/components/lineage-visibility-toggle';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'lineage',
  description: 'parent to child provenance of generated images'
};

export default async function LineagePage() {
  const session = await auth();
  const ownerId = getSiteAdminId();
  const { lineagePublic } = await getGalleryDefaults(ownerId);
  const owner = isSiteAdmin(session);

  // Private by default: only the owner sees it unless they have published it.
  if (!owner && !lineagePublic) notFound();

  const graph = await getLineageGraph(ownerId);

  return (
    <div className="space-y-6 py-6">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="font-display text-3xl text-ink-100">lineage</h1>
          {owner ? <LineageVisibilityToggle initial={lineagePublic} /> : null}
        </div>
        <p className="font-mono text-xs text-ink-500">
          parent to child provenance: each edge points from an image to the image it helped
          generate.
        </p>
      </header>
      <LineageGraph nodes={graph.nodes} edges={graph.edges} />
    </div>
  );
}
