import { NextResponse } from 'next/server';
import { buildOpenApiDoc } from '@/lib/api/catalog';
import { CORS_HEADERS, optionsResponse } from '@/lib/random/http';

export const runtime = 'nodejs';

// GET /api/openapi.json -- OpenAPI 3.1 document for the public API. Consumable
// by Swagger UI, Postman, and client codegen.
export function GET() {
  return NextResponse.json(buildOpenApiDoc(), {
    headers: { ...CORS_HEADERS, 'Cache-Control': 'public, s-maxage=300' }
  });
}

export function OPTIONS() {
  return optionsResponse();
}
