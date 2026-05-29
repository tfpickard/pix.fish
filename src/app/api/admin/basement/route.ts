import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import { getImageById, setImageBasement } from '@/lib/db/queries/basement';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Admin-only endpoint to set or unset the basement flag on any image.
// No middleware covers /api/admin/basement, so we gate explicitly here.
//
// POST { imageId: number, basement: boolean }
//   -> 200 { image: { id, slug, basement } }
export async function POST(req: Request) {
  const session = await auth();
  if (!isSiteAdmin(session)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  if (
    !body ||
    typeof body !== 'object' ||
    typeof (body as Record<string, unknown>).imageId !== 'number' ||
    typeof (body as Record<string, unknown>).basement !== 'boolean'
  ) {
    return NextResponse.json(
      { error: 'body must be { imageId: number, basement: boolean }' },
      { status: 400 }
    );
  }

  const { imageId, basement } = body as { imageId: number; basement: boolean };

  const existing = await getImageById(imageId);
  if (!existing) {
    return NextResponse.json({ error: 'image not found' }, { status: 404 });
  }

  const updated = await setImageBasement(imageId, basement);
  if (!updated) {
    return NextResponse.json({ error: 'update failed' }, { status: 500 });
  }

  return NextResponse.json({
    image: { id: updated.id, slug: updated.slug, basement: updated.basement }
  });
}
