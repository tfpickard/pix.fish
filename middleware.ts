import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';

// Guards owner-only areas:
//   /admin/*                              -- require owner session
//   POST/PATCH/DELETE /api/images*        -- require owner session
// Public reads (GET) are unauthenticated.
export default auth((req) => {
  const { pathname } = req.nextUrl;
  const method = req.method.toUpperCase();
  const ownerId = process.env.OWNER_GITHUB_ID;
  const githubId = req.auth?.user?.githubId;
  const isOwner = !!ownerId && githubId === ownerId;

  const isAdminRoute = pathname.startsWith('/admin');
  const isImagesWrite =
    pathname.startsWith('/api/images') &&
    (method === 'POST' || method === 'PATCH' || method === 'DELETE');
  // PATCH and DELETE on /api/comments/:id are owner-only moderation actions.
  // Public POST (submitting a comment) goes to /api/images/:slug/comments, not here.
  const isCommentsWrite =
    pathname.startsWith('/api/comments') &&
    (method === 'PATCH' || method === 'DELETE');

  if (isAdminRoute) {
    if (!req.auth) {
      const url = new URL('/api/auth/signin', req.url);
      url.searchParams.set('callbackUrl', pathname);
      return NextResponse.redirect(url);
    }
    if (!isOwner) {
      return NextResponse.redirect(new URL('/', req.url));
    }
  }

  if ((isImagesWrite || isCommentsWrite) && !isOwner) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  return NextResponse.next();
});

export const config = {
  matcher: ['/admin/:path*', '/api/images/:path*', '/api/comments/:path*']
};
