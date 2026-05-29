import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import { getGalleryDefaults } from '@/lib/db/queries/gallery-config';
import { getSiteAdminId } from '@/lib/db/queries/users';
import { getLineageGraph } from '@/lib/db/queries/lineage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The lineage graph is the site admin's creative provenance. Visible to the
// admin always; to everyone else only when the admin has flipped the
// lineage_public toggle.
export async function GET() {
  const session = await auth();
  const ownerId = getSiteAdminId();
  const { lineagePublic } = await getGalleryDefaults(ownerId);

  if (!isSiteAdmin(session) && !lineagePublic) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  const graph = await getLineageGraph(ownerId);
  return NextResponse.json({ ...graph, public: lineagePublic });
}
