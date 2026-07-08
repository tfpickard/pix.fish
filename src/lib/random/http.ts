import { NextResponse } from 'next/server';

// Shared response helpers for the public /api/random surface and the API
// discovery endpoints. Two cross-cutting concerns live here:
//
//  1. CORS -- these routes are a public, embeddable read API (targeted at
//     programmatic retrieval), so they send Access-Control-Allow-Origin: * and
//     answer preflight. The rest of the app is same-origin and sets no CORS.
//  2. Caching -- a random pick must never be frozen by a CDN or the browser, so
//     random responses are Cache-Control: no-store. (Discovery endpoints opt
//     into their own caching and don't use these random helpers.)

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

const NO_STORE = 'no-store';

// JSON response for random routes: CORS + no-store, plus any extra headers.
export function jsonRandom(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {}
): NextResponse {
  return NextResponse.json(body as object, {
    status,
    headers: { ...CORS_HEADERS, 'Cache-Control': NO_STORE, ...extraHeaders }
  });
}

// Standard 404 for "no image matched" (empty gallery or pinned-not-found).
export function notFoundRandom(): NextResponse {
  return jsonRandom({ error: 'not found' }, 404);
}

// Binary/streamed response for /image, /raw: CORS + no-store baked in.
export function bytesRandom(
  body: BodyInit | null,
  headers: Record<string, string>,
  status = 200
): NextResponse {
  return new NextResponse(body, {
    status,
    headers: { ...CORS_HEADERS, 'Cache-Control': NO_STORE, ...headers }
  });
}

// Preflight handler re-exported as OPTIONS from every random route.
export function optionsResponse(): NextResponse {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
