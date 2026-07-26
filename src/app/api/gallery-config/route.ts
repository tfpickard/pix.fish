import { NextResponse } from 'next/server';
import { auth, isSiteAdmin } from '@/lib/auth';
import {
  GALLERY_KEYS,
  getGalleryDefaults,
  setGalleryDefault
} from '@/lib/db/queries/gallery-config';
import { getSiteAdminId } from '@/lib/db/queries/users';
import { invalidateGalleryDefaults } from '@/lib/db/queries/gallery-stream';
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
    autoApproveComments?: unknown;
  };

  const ownerId = getSiteAdminId();

  // Validate the whole payload before writing any of it. Validating and
  // writing field-by-field meant a request with a good first field and a bad
  // second one persisted the first write and then returned 400 -- leaving the
  // config half-updated, and skipping the memo invalidation below so this
  // instance served the superseded value for the rest of the TTL. Collecting
  // the writes first makes the handler all-or-nothing.
  const writes: { key: string; value: string }[] = [];

  if (payload.defaultSort !== undefined) {
    if (typeof payload.defaultSort !== 'string' || !isSortMode(payload.defaultSort)) {
      return NextResponse.json({ error: 'invalid defaultSort' }, { status: 400 });
    }
    writes.push({ key: GALLERY_KEYS.defaultSort, value: payload.defaultSort });
  }
  if (payload.defaultShufflePeriod !== undefined) {
    if (
      typeof payload.defaultShufflePeriod !== 'string' ||
      !isShufflePeriod(payload.defaultShufflePeriod)
    ) {
      return NextResponse.json({ error: 'invalid defaultShufflePeriod' }, { status: 400 });
    }
    writes.push({
      key: GALLERY_KEYS.defaultShufflePeriod,
      value: payload.defaultShufflePeriod
    });
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
    writes.push({ key: GALLERY_KEYS.searchSimilarityThreshold, value: n.toFixed(3) });
  }
  if (payload.autoApproveComments !== undefined) {
    if (typeof payload.autoApproveComments !== 'boolean') {
      return NextResponse.json(
        { error: 'invalid autoApproveComments (expected boolean)' },
        { status: 400 }
      );
    }
    writes.push({
      key: GALLERY_KEYS.autoApproveComments,
      value: payload.autoApproveComments ? 'true' : 'false'
    });
  }

  try {
    for (const { key, value } of writes) {
      await setGalleryDefault(ownerId, key, value);
    }
  } finally {
    // The homepage and /api/images read these defaults through a
    // process-local memo. Clear it even if a write throws part-way: whatever
    // did land must not be masked by a stale memo for the rest of the TTL.
    if (writes.length > 0) invalidateGalleryDefaults(ownerId);
  }

  const defaults = await getGalleryDefaults(ownerId);
  return NextResponse.json(defaults);
}
