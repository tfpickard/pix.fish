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

// Which of the two gated shapes a request falls into, or null for everything
// else. This is deliberately a standalone predicate rather than logic inside
// the auth wrapper: the wrapper decodes and verifies the session JWT before
// the callback ever runs, so asking first lets a public read -- `GET
// /api/images` on every infinite-scroll page -- skip that work entirely.
// Returning null here can only skip auth for requests the gate would have
// waved through anyway.
type AuthGate = 'admin-page' | 'write';

// Prefix match on a path-segment boundary. Plain startsWith('/admin') was safe
// while the matcher was '/admin/:path*' (Next matches that per segment), but
// the matcher is now a catch-all, so this is the only boundary left -- and
// without it `/administration` reads as an admin route. That matters here
// because the legacy bare `/<slug>` route (src/app/[slug]/page.tsx) is a live
// public URL shape: any image whose caption slugifies to something starting
// with "admin" would get redirected to sign-in instead of rendering.
function underPath(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function authGateFor(pathname: string, method: string): AuthGate | null {
  if (underPath(pathname, '/admin')) return 'admin-page';

  if (method !== 'POST' && method !== 'PATCH' && method !== 'DELETE') return null;

  // Reactions and comments are the two anonymous-public POSTs under
  // /api/images: a visitor reacts or leaves a (pending) comment without ever
  // signing in. A blanket "POST under /api/images needs a session" would 403
  // both, so they are carved out here and left to their own in-handler
  // IP-hash throttles.
  if (method === 'POST' && (pathname.endsWith('/reactions') || pathname.endsWith('/comments'))) {
    return null;
  }

  if (underPath(pathname, '/api/images')) return 'write';
  // PATCH and DELETE on /api/comments/:id are moderation actions. Public
  // POST (visitor leaves a comment) goes to /api/images/:slug/comments.
  if (underPath(pathname, '/api/comments') && method !== 'POST') return 'write';

  return null;
}

const authGateHandler = auth((req) => {
  const gate = authGateFor(req.nextUrl.pathname, req.method.toUpperCase());
  if (!gate || req.auth) return NextResponse.next();

  if (gate === 'admin-page') {
    const url = new URL('/signin', req.url);
    // pathname + search, not pathname alone: /admin/gallery?tab=sort has to
    // come back with its tab intact rather than as a bare path. Both halves
    // come from nextUrl, so the value stays relative and cannot be turned
    // into an off-site redirect.
    url.searchParams.set('callbackUrl', `${req.nextUrl.pathname}${req.nextUrl.search}`);
    return NextResponse.redirect(url);
  }

  return NextResponse.json({ error: 'forbidden' }, { status: 403 });
});

// `auth(handler)` is typed as an App Router route handler, but its runtime
// arg-shape dispatch also accepts the (request, event) pair Next.js hands to
// middleware -- that is the documented way to use it. Narrow the type back to
// the middleware signature here so the single call site below stays clean.
const authGate = authGateHandler as unknown as NextMiddleware;

// Generous enough that a human browsing the gallery -- including infinite
// scroll firing /api/images pages and a burst of parallel requests on first
// paint -- never sees a 429, while a client pulling tens of requests a second
// is capped. Override per-deployment with RATE_LIMIT_RPM; set
// RATE_LIMIT_DISABLED=1 to switch the gate off without a code change.
const DEFAULT_RPM = 200;
const WINDOW_MS = 60_000;
// /api/auth/* gets its own, smaller bucket rather than the page allowance.
// A real sign-in is a handful of requests, so 60 is unreachable in normal use,
// and keeping it separate means a client that has burned its page allowance
// mid-flood can still complete an OAuth callback instead of being stranded on
// a 429 it cannot retry past.
const AUTH_RPM = 60;

function requestsPerMinute(): number {
  const raw = Number(process.env.RATE_LIMIT_RPM);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_RPM;
}

// Vercel Cron is the one caller that must never be throttled: a throttled
// drain silently stops the job queue. Being *on* a cron path is not enough to
// earn that, though -- these are public URLs, and exempting the path alone
// lets anyone hammer /api/cron/jobs into unlimited Node invocations that load
// the whole worker dependency graph before returning 403. Only a request
// carrying the secret skips the limiter; everyone else is ordinary traffic.
// Same bearer comparison the handler itself does (src/app/api/cron/jobs).
function isAuthorizedCron(req: NextRequest, pathname: string): boolean {
  if (!underPath(pathname, '/api/cron')) return false;
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return (req.headers.get('authorization') ?? '') === `Bearer ${secret}`;
}

type Bucket = { key: string; limit: number };

function bucketFor(req: NextRequest, pathname: string): Bucket | null {
  if (isAuthorizedCron(req, pathname)) return null;

  const ip = clientIp(req);
  if (underPath(pathname, '/api/auth')) return { key: `auth:${ip}`, limit: AUTH_RPM };
  return { key: `edge:${ip}`, limit: requestsPerMinute() };
}

// `req.ip` is populated by Vercel from its own trusted view of the connection,
// so it cannot be influenced by request headers at all -- prefer it. Vercel
// does overwrite x-forwarded-for rather than appending to a client-supplied
// chain (per Vercel's request-headers docs), so the header fallbacks are sound
// on this deployment; they are ordered least-forgeable-first anyway so that
// enabling Enterprise trusted-proxy forwarding later cannot silently turn the
// limiter key into an attacker-controlled value. 'unknown' collapses
// unattributable traffic into one shared bucket, which is the safe direction:
// it throttles harder, never less.
function clientIp(req: NextRequest): string {
  if (req.ip) return req.ip;
  const realIp = req.headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;
  const forwarded = req.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || 'unknown';
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

  if (process.env.RATE_LIMIT_DISABLED !== '1') {
    const bucket = bucketFor(req, pathname);
    if (bucket) {
      const verdict = edgeRateLimit(bucket.key, bucket.limit, WINDOW_MS);
      // Short-circuit before the auth gate: a throttled request should not
      // cost a JWT verification, and it must never reach the page render,
      // which is where the Postgres queries and the real cost live.
      if (!verdict.ok) return tooManyRequests(pathname, verdict.retryAfter, verdict.limit);
    }
  }

  if (authGateFor(pathname, req.method.toUpperCase())) return authGate(req, event);

  return NextResponse.next();
}

export const config = {
  // Widened from the three auth-gated prefixes so the rate limiter can see
  // page traffic too -- the flood that motivated this hit `/`, not an API
  // route.
  //
  // The exclusions are an explicit inventory of `public/` plus Next's own
  // build output, NOT a file-extension pattern. An extension rule looks
  // equivalent and is not: `/anything.png` matches no static file but still
  // resolves through src/app/[slug]/page.tsx, and `/api/images/anything.png`
  // through the [slug] route handler, so excluding `*.png` would hand an
  // attacker a whole family of database-backed paths that never reach the
  // limiter. Anything not named below is dynamic and must be counted.
  //
  // Directory prefixes (icons/, fonts/) are safe to exclude wholesale because
  // the legacy bare-slug route is a single segment and cannot collide with
  // them. Single-segment files are listed exactly, for the same reason
  // `/logo-anything` must not be excluded by a `logo-` prefix.
  //
  // Keep this in sync when adding to public/ -- a missed file costs one
  // middleware invocation per request, which is the safe direction to err.
  matcher: [
    '/((?!_next/|icons/|fonts/|favicon\\.ico$|favicon-light\\.ico$|favicon-dark\\.ico$|icon\\.png$|sw\\.js$|grain\\.svg$|logo-light\\.png$|logo-dark\\.png$|logo-magenta\\.png$|pisci-avatar\\.png$|manifest\\.webmanifest$).*)'
  ]
};
