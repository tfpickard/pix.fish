import { redirect } from 'next/navigation';
import { auth, isSiteAdmin } from '@/lib/auth';
import { getFittestImages, getPopulationStats } from '@/lib/db/queries/alive';
import { AliveClient, type FittestRow } from './_components/alive-client';

export const dynamic = 'force-dynamic';

// feat/alive admin console. Server component gates on isSiteAdmin and loads the
// roster + stats, then hands off to the client component for the reproduce form
// and archive toggles. (Following the breed page pattern: a server gate around
// a client island, since a pure 'use client' page cannot call auth()/the DB.)

export default async function AdminAlivePage() {
  const session = await auth();
  if (!isSiteAdmin(session) || !session?.user?.id) redirect('/admin/upload');

  // Include archived rows so the admin can see and unarchive "dead" images.
  const [fittest, stats] = await Promise.all([
    getFittestImages(10, { includeArchived: true }),
    getPopulationStats()
  ]);

  const rows: FittestRow[] = fittest.map((f) => ({
    imageId: f.imageId,
    slug: f.slug,
    handle: f.handle,
    blobUrl: f.blobUrl,
    generation: f.generation,
    fitness: f.fitness,
    hasEmbedding: f.embedding != null,
    archived: f.archivedAt != null
  }));

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="font-display text-3xl text-ink-100">alive</h1>
        <p className="font-mono text-xs text-ink-500">
          the fish is alive. images compete on attention, reproduce, and are archived (never
          deleted). reproduction interpolates two parents&apos; caption embeddings and inherits a
          Dirichlet-blended tag set, then renders a child via the image generator. dry-run shows
          exactly what would happen before you commit.
        </p>
      </header>
      <AliveClient rows={rows} stats={stats} />
    </div>
  );
}
