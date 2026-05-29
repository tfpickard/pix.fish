import { NextResponse } from 'next/server';
import { z } from 'zod';
import { auth, isSiteAdmin } from '@/lib/auth';
import { getImagesByIdsOrdered } from '@/lib/db/queries/images';
import { archiveImage, unarchiveImage } from '@/lib/db/queries/alive';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// feat/alive -- archive / unarchive toggle.
//
// SAFETY: archive is a soft delete. It stamps images.archived_at so the row
// disappears from public surfaces (the query layer filters archivedAt IS NOT
// NULL) while staying fully recoverable. There is no hard-delete path here;
// unarchive clears the timestamp and the image returns. isSiteAdmin-gated.

const bodySchema = z.object({
  imageId: z.number().int().positive(),
  action: z.enum(['archive', 'unarchive'])
});

export async function POST(req: Request) {
  const session = await auth();
  if (!isSiteAdmin(session)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid body', issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const { imageId, action } = parsed.data;

  const result =
    action === 'archive' ? await archiveImage(imageId) : await unarchiveImage(imageId);

  // archiveImage returns null when the row is already archived (its WHERE has
  // archivedAt IS NULL); treat that as a no-op success rather than an error so
  // a double-click is harmless.
  const [updated] = await getImagesByIdsOrdered([imageId]);
  if (!updated) {
    return NextResponse.json({ error: 'image not found' }, { status: 404 });
  }

  return NextResponse.json({
    image: {
      id: updated.id,
      slug: updated.slug,
      archivedAt: updated.archivedAt ? updated.archivedAt.toISOString() : null
    },
    changed: !!result
  });
}
