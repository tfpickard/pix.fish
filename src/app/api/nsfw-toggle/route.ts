import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SHOW_NSFW_COOKIE, type NsfwMode } from '@/lib/nsfw';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Cycles the visitor NSFW preference cookie through three states:
//   hide -> include -> only -> hide
// POST is the only method so stray GETs never change state.
// Caller should refresh the current page after the call.
export async function POST() {
  const store = await cookies();
  const current = store.get(SHOW_NSFW_COOKIE)?.value;
  const next: NsfwMode =
    current === 'true' ? 'only' : current === 'only' ? 'hide' : 'include';
  const cookieVal = next === 'hide' ? 'false' : next === 'only' ? 'only' : 'true';
  store.set(SHOW_NSFW_COOKIE, cookieVal, {
    httpOnly: false, // visible to client JS so the toggle UI can read state
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365
  });
  return NextResponse.json({ nsfwMode: next });
}
