import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import { GALLERY_KEYS, setGalleryDefault } from '@/lib/db/queries/gallery-config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Owner toggle for whether their /lineage graph is public. Stored as a
// gallery_config row so it lives with the rest of the per-user UI prefs.
export async function POST(req: Request) {
  const session = await auth();
  if (!isSiteAdmin(session) || !session?.user?.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as { public?: unknown } | null;
  if (typeof body?.public !== 'boolean') {
    return NextResponse.json({ error: 'public must be a boolean' }, { status: 400 });
  }

  await setGalleryDefault(session.user.id, GALLERY_KEYS.lineagePublic, body.public ? 'true' : 'false');
  return NextResponse.json({ public: body.public });
}
