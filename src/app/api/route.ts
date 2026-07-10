import { NextResponse } from 'next/server';
import { buildApiIndex } from '@/lib/api/catalog';
import { CORS_HEADERS, optionsResponse } from '@/lib/random/http';

export const runtime = 'nodejs';

// GET /api -- self-describing index of the public API. Points at the full
// OpenAPI document and lists the available endpoints.
export function GET() {
  return NextResponse.json(buildApiIndex(), {
    headers: { ...CORS_HEADERS, 'Cache-Control': 'public, s-maxage=300' }
  });
}

export function OPTIONS() {
  return optionsResponse();
}
