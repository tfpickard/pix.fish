import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { BASEMENT_COOKIE } from '@/lib/basement';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST unlocks when locked, locks when unlocked (toggles). The caller
// passes { action: 'unlock' | 'lock' } to avoid accidental round-trips
// flipping state the wrong way -- the unlock ritual always sends 'unlock'
// and the lock button always sends 'lock'. A missing or unknown action
// defaults to toggle so the endpoint stays useful in manual testing.
//
// The cookie is httpOnly: false intentionally -- the /basement page's
// client wrapper needs to detect state on hydration for the lock button.
// The real security is the server-side query gate; the cookie is just
// the signal, not the lock itself.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const store = await cookies();
  const current = store.get(BASEMENT_COOKIE)?.value === 'unlocked';

  let next: boolean;
  if (body.action === 'unlock') {
    next = true;
  } else if (body.action === 'lock') {
    next = false;
  } else {
    next = !current;
  }

  if (next) {
    store.set(BASEMENT_COOKIE, 'unlocked', {
      httpOnly: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7 // one week -- short enough to re-gate stale browsers
    });
  } else {
    store.delete(BASEMENT_COOKIE);
  }

  return NextResponse.json({ unlocked: next });
}
