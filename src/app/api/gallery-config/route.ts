import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import {
  GALLERY_KEYS,
  getGalleryDefaults,
  setGalleryDefault
} from '@/lib/db/queries/gallery-config';
import { getSiteAdminId } from '@/lib/db/queries/users';
import { isShufflePeriod, isSortMode } from '@/lib/sort/types';

export const dynamic = 'force-dynamic';

// Public GET: visitors need the owner's defaults on first paint so the
// sort bar can render the correct "(owner default)" labels and pre-apply
// the cadence before the user touches anything.
export async function GET() {
  const defaults = await getGalleryDefaults(getSiteAdminId());
  return NextResponse.json(defaults);
}

// Owner-only PATCH. Validates both fields against the hard-coded enums in
// src/lib/sort/types.ts so the table never holds a value the UI can't
// render. Either field is optional; sending none is a no-op.
export async function PATCH(req: Request) {
  const session = await auth();
  if (!isSiteAdmin(session)) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const payload = body as {
    defaultSort?: unknown;
    defaultShufflePeriod?: unknown;
    searchSimilarityThreshold?: unknown;
  };

  const ownerId = getSiteAdminId();
  if (payload.defaultSort !== undefined) {
    if (typeof payload.defaultSort !== 'string' || !isSortMode(payload.defaultSort)) {
      return NextResponse.json({ error: 'invalid defaultSort' }, { status: 400 });
    }
    await setGalleryDefault(ownerId, GALLERY_KEYS.defaultSort, payload.defaultSort);
  }
  if (payload.defaultShufflePeriod !== undefined) {
    if (
      typeof payload.defaultShufflePeriod !== 'string' ||
      !isShufflePeriod(payload.defaultShufflePeriod)
    ) {
      return NextResponse.json({ error: 'invalid defaultShufflePeriod' }, { status: 400 });
    }
    await setGalleryDefault(ownerId, GALLERY_KEYS.defaultShufflePeriod, payload.defaultShufflePeriod);
  }
  if (payload.searchSimilarityThreshold !== undefined) {
    const n = Number(payload.searchSimilarityThreshold);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      return NextResponse.json(
        { error: 'invalid searchSimilarityThreshold (expected 0..1)' },
        { status: 400 }
      );
    }
    // Store with three decimal places of precision; the slider step is
    // 0.05 but freeform PATCH callers can submit anything in range.
    await setGalleryDefault(
      ownerId,
      GALLERY_KEYS.searchSimilarityThreshold,
      n.toFixed(3)
    );
  }

  const defaults = await getGalleryDefaults(ownerId);
  return NextResponse.json(defaults);
}
