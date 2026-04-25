import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SHOW_NSFW_COOKIE } from '@/lib/nsfw';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Toggles the visitor "Show NSFW" preference cookie. POST is the only
// method so a stray GET (link prefetch, browser preload) doesn't change
// state. The body is ignored; the cookie is flipped relative to its
// current value. Caller should refresh the current page after the call.
export async function POST() {
  const store = await cookies();
  const current = store.get(SHOW_NSFW_COOKIE)?.value === 'true';
  store.set(SHOW_NSFW_COOKIE, current ? 'false' : 'true', {
    httpOnly: false, // visible to client JS so the toggle UI can read state
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365 // one year
  });
  return NextResponse.json({ showNsfw: !current });
}
