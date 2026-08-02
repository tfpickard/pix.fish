import { NextResponse, type NextFetchEvent, type NextMiddleware, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';
import { edgeRateLimit } from '@/lib/edge-rate-limit';

// This file lives in `src/` and not the repo root on purpose. With a `src`
// directory Next.js only picks up `src/middleware.ts`; a root-level
// middleware.ts compiles to nothing and silently never runs.
//
// Phase F: middleware enforces "must be signed in" only. Resource-level
// ownership is checked inside route handlers via canEdit() because
// determining whether a user owns a /api/images/<slug> requires a DB
// read that doesn't belong in middleware. Site-admin-only admin pages
// also self-gate inside the page (via isSiteAdmin); non-admin users who
// hit /admin/* are still allowed past middleware -- the page itself
// either renders the per-user surface or redirects.
const authGateHandler = auth((req) => {
  const { pathname } = req.nextUrl;
  const method = req.method.toUpperCase();

  const isAdminRoute = pathname.startsWith('/admin');
  // Reactions and comments are the two anonymous-public POSTs under
  // /api/images: a visitor reacts or leaves a (pending) comment without ever
  // signing in. A blanket "POST under /api/images needs a session" would 403
  // both, so they are carved out here and left to their own in-handler
  // IP-hash throttles.
  const isPublicEngagementWrite =
    method === 'POST' &&
    (pathname.endsWith('/reactions') || pathname.endsWith('/comments'));
  const isImagesWrite =
    pathname.startsWith('/api/images') &&
    !isPublicEngagementWrite &&
    (method === 'POST' || method === 'PATCH' || method === 'DELETE');
  // PATCH and DELETE on /api/comments/:id are moderation actions. Public
  // POST (visitor leaves a comment) goes to /api/images/:slug/comments.
  const isCommentsWrite =
    pathname.startsWith('/api/comments') &&
    (method === 'PATCH' || method === 'DELETE');

  if (isAdminRoute && !req.auth) {
    const url = new URL('/signin', req.url);
    url.searchParams.set('callbackUrl', pathname);
    return NextResponse.redirect(url);
  }

  if ((isImagesWrite || isCommentsWrite) && !req.auth) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  return NextResponse.next();
});

// `auth(handler)` is typed as an App Router route handler, but its runtime
// arg-shape dispatch also accepts the (request, event) pair Next.js hands to
// middleware -- that is the documented way to use it. Narrow the type back to
// the middleware signature here so the single call site below stays clean.
const authGate = authGateHandler as unknown as NextMiddleware;

// Paths whose auth gate lives in the wrapper above. Everything else that now
// matches the middleware only passes through the rate limiter, so widening the
// matcher for rate limiting cannot change any authorization behavior.
function needsAuthGate(pathname: string): boolean {
  return (
    pathname.startsWith('/admin') ||
    pathname.startsWith('/api/images') ||
    pathname.startsWith('/api/comments')
  );
}

// Requests we never throttle. Vercel Cron calls originate from Vercel infra
// with IPs we do not control, and every cron route is already gated by a
// CRON_SECRET bearer token, so an IP counter there can only cause an outage.
// /api/auth/* is NextAuth's own callback surface: a throttled OAuth callback
// strands the user mid-sign-in, and the credentials path does its own
// per-email and per-IP throttling in `authorize`.
function isExempt(pathname: string): boolean {
  return pathname.startsWith('/api/cron') || pathname.startsWith('/api/auth');
}

// Generous enough that a human browsing the gallery -- including infinite
// scroll firing /api/images pages and a burst of parallel requests on first
// paint -- never sees a 429, while a client pulling tens of requests a second
// is capped. Override per-deployment with RATE_LIMIT_RPM; set
// RATE_LIMIT_DISABLED=1 to switch the gate off without a code change.
const DEFAULT_RPM = 200;
const WINDOW_MS = 60_000;

function requestsPerMinute(): number {
  const raw = Number(process.env.RATE_LIMIT_RPM);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_RPM;
}

// The edge sees the client IP directly on x-real-ip; x-forwarded-for is the
// chain, whose first entry is the original client. Both are set by Vercel's
// proxy and cannot be spoofed past it. 'unknown' collapses unattributable
// traffic into one shared bucket, which is the safe direction: it throttles
// harder, never less.
function clientIp(req: NextRequest): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

function tooManyRequests(pathname: string, retryAfter: number, limit: number): NextResponse {
  const headers = {
    'Retry-After': String(retryAfter),
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': '0',
    // Nothing about a throttled response is worth caching or indexing.
    'Cache-Control': 'no-store'
  };

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'rate_limited', retryAfter }, { status: 429, headers });
  }

  return new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>Slow down</title>` +
      `<body style="font:16px/1.5 system-ui;padding:3rem;max-width:34rem;margin:0 auto">` +
      `<h1>Slow down</h1><p>Too many requests from your address. ` +
      `Try again in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.</p></body>`,
    { status: 429, headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

export default function middleware(req: NextRequest, event: NextFetchEvent) {
  const { pathname } = req.nextUrl;

  if (process.env.RATE_LIMIT_DISABLED !== '1' && !isExempt(pathname)) {
    const limit = requestsPerMinute();
    const verdict = edgeRateLimit(`edge:${clientIp(req)}`, limit, WINDOW_MS);
    // Short-circuit before the auth gate: a throttled request should not cost
    // a JWT verification, and it must never reach the page render, which is
    // where the Postgres queries and the real invocation cost live.
    if (!verdict.ok) return tooManyRequests(pathname, verdict.retryAfter, verdict.limit);
  }

  if (needsAuthGate(pathname)) return authGate(req, event);

  return NextResponse.next();
}

export const config = {
  // Widened from the three auth-gated prefixes so the rate limiter can see
  // page traffic too -- the flood that motivated this hit `/`, not an API
  // route. Static assets are excluded: they are served from the CDN and
  // matching them would add a middleware invocation per asset for no gain.
  matcher: [
    '/((?!_next/static|_next/image|_next/data|favicon\\.ico|icon\\.png|sw\\.js|.*\\.(?:png|jpg|jpeg|gif|webp|avif|svg|ico|woff|woff2|ttf|map)$).*)'
  ]
};
