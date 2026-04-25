import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

// Phase F: middleware enforces "must be signed in" only. Resource-level
// ownership is checked inside route handlers via canEdit() because
// determining whether a user owns a /api/images/<slug> requires a DB
// read that doesn't belong in middleware. Site-admin-only admin pages
// also self-gate inside the page (via isSiteAdmin); non-admin users who
// hit /admin/* are still allowed past middleware -- the page itself
// either renders the per-user surface or redirects.
export default auth((req) => {
  const { pathname } = req.nextUrl;
  const method = req.method.toUpperCase();

  const isAdminRoute = pathname.startsWith('/admin');
  const isImagesWrite =
    pathname.startsWith('/api/images') &&
    (method === 'POST' || method === 'PATCH' || method === 'DELETE');
  // PATCH and DELETE on /api/comments/:id are moderation actions. Public
  // POST (visitor leaves a comment) goes to /api/images/:slug/comments.
  const isCommentsWrite =
    pathname.startsWith('/api/comments') &&
    (method === 'PATCH' || method === 'DELETE');

  if (isAdminRoute && !req.auth) {
    const url = new URL('/api/auth/signin', req.url);
    url.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(url);
  }

  if ((isImagesWrite || isCommentsWrite) && !req.auth) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  return NextResponse.next();
});

export const config = {
  matcher: ['/admin/:path*', '/api/images/:path*', '/api/comments/:path*']
};
