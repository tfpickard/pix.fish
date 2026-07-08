import pkg from '../../../package.json';
import { SITE_NAME, SITE_URL } from '@/lib/site';

// Single source of truth for the PUBLIC, programmatic-facing HTTP API. Both the
// /api index and the /api/openapi.json document are derived from this list so
// they can never drift. Admin/cron/internal routes are intentionally omitted --
// this describes the surface meant for outside consumers.

export type ApiParam = {
  name: string;
  in: 'query' | 'path';
  required?: boolean;
  type?: 'string' | 'integer' | 'boolean';
  description: string;
};

export type ApiEndpoint = {
  method: 'GET';
  path: string;
  summary: string;
  tags: string[];
  params?: ApiParam[];
};

// Query params shared by every /api/random route.
const RANDOM_PARAMS: ApiParam[] = [
  { name: 'id', in: 'query', type: 'integer', description: 'Pin a specific image by globally-unique numeric id (the reliable way to pin) instead of picking at random.' },
  { name: 'slug', in: 'query', type: 'string', description: 'Pin by slug. Slugs are unique only per owner, so pair with `handle` to pin unambiguously; a bare slug resolves to the oldest match across users.' },
  { name: 'handle', in: 'query', type: 'string', description: 'Owner handle, combined with `slug` for an unambiguous owner-scoped pin.' },
  {
    name: 'include_nsfw',
    in: 'query',
    type: 'string',
    description: "Override the NSFW visibility cookie: '1'/'true' to include NSFW, 'only' for NSFW-only."
  }
];

const NSFW_PARAM: ApiParam = {
  name: 'include_nsfw',
  in: 'query',
  type: 'string',
  description: "Override the NSFW visibility cookie: '1'/'true' to include NSFW, 'only' for NSFW-only."
};

const PAGINATION_PARAMS: ApiParam[] = [
  { name: 'limit', in: 'query', type: 'integer', description: 'Max rows to return.' },
  { name: 'offset', in: 'query', type: 'integer', description: 'Rows to skip (pagination).' }
];

export const API_ENDPOINTS: ApiEndpoint[] = [
  // Random surface.
  { method: 'GET', path: '/api/random', summary: 'A random image and everything stored about it, as JSON.', tags: ['random'], params: RANDOM_PARAMS },
  { method: 'GET', path: '/api/random/data', summary: 'Alias of /api/random: the full JSON record.', tags: ['random'], params: RANDOM_PARAMS },
  { method: 'GET', path: '/api/random/image', summary: 'The random image bytes, served inline (browser-renderable).', tags: ['random'], params: RANDOM_PARAMS },
  { method: 'GET', path: '/api/random/raw', summary: 'The random image bytes, served as a file download.', tags: ['random'], params: RANDOM_PARAMS },
  { method: 'GET', path: '/api/random/uri', summary: 'The random image as a base64 data: URI for inline embedding.', tags: ['random'], params: RANDOM_PARAMS },
  { method: 'GET', path: '/api/random/name', summary: "The random image's name (slug) and a download filename.", tags: ['random'], params: RANDOM_PARAMS },
  { method: 'GET', path: '/api/random/size', summary: "The random image's size in bytes.", tags: ['random'], params: RANDOM_PARAMS },
  { method: 'GET', path: '/api/random/date', summary: "The random image's date (taken-at if known, else uploaded-at).", tags: ['random'], params: RANDOM_PARAMS },
  { method: 'GET', path: '/api/random/metadata', summary: "The random image's stored metadata (EXIF, palette, dimensions, mime, flags).", tags: ['random'], params: RANDOM_PARAMS },
  { method: 'GET', path: '/api/random/description', summary: "A description of the random image (one variant, plus all variants).", tags: ['random'], params: RANDOM_PARAMS },
  { method: 'GET', path: '/api/random/caption', summary: 'A caption for the random image (one variant, plus all variants).', tags: ['random'], params: RANDOM_PARAMS },
  { method: 'GET', path: '/api/random/likes', summary: "The random image's like count.", tags: ['random'], params: RANDOM_PARAMS },
  { method: 'GET', path: '/api/random/dislikes', summary: "The random image's dislike count.", tags: ['random'], params: RANDOM_PARAMS },
  { method: 'GET', path: '/api/random/comments', summary: "The random image's approved public comments.", tags: ['random'], params: RANDOM_PARAMS },

  // Core public gallery read surface.
  {
    method: 'GET',
    path: '/api/images',
    summary: 'Paginated image feed with sort/shuffle strategies.',
    tags: ['images'],
    params: [
      ...PAGINATION_PARAMS,
      { name: 'tag', in: 'query', type: 'string', description: 'Filter by tag (repeatable; AND semantics).' },
      { name: 'sort', in: 'query', type: 'string', description: 'Sort/shuffle mode (e.g. newest, oldest, random, rainbow).' },
      { name: 'seed', in: 'query', type: 'string', description: 'Seed for the shuffle-based sort modes.' },
      NSFW_PARAM
    ]
  },
  {
    method: 'GET',
    path: '/api/images/{slug}',
    summary: 'A single image by slug, hydrated with captions/descriptions/tags.',
    tags: ['images'],
    params: [{ name: 'slug', in: 'path', required: true, type: 'string', description: 'Image slug.' }]
  },
  {
    method: 'GET',
    path: '/api/images/{slug}/reactions',
    summary: 'Reaction counts { up, down } for an image.',
    tags: ['images'],
    params: [{ name: 'slug', in: 'path', required: true, type: 'string', description: 'Image slug.' }]
  },
  {
    method: 'GET',
    path: '/api/images/{slug}/comments',
    summary: 'Approved public comments for an image.',
    tags: ['images'],
    params: [{ name: 'slug', in: 'path', required: true, type: 'string', description: 'Image slug.' }]
  },
  {
    method: 'GET',
    path: '/api/search',
    summary: 'Semantic search over caption embeddings.',
    tags: ['discovery'],
    params: [
      { name: 'q', in: 'query', required: true, type: 'string', description: 'Search query.' },
      { name: 'limit', in: 'query', type: 'integer', description: 'Max results.' },
      NSFW_PARAM
    ]
  },
  {
    method: 'GET',
    path: '/api/color/{hex}/images',
    summary: 'Images whose extracted palette matches a hex color.',
    tags: ['discovery'],
    params: [
      { name: 'hex', in: 'path', required: true, type: 'string', description: 'Hex color (with or without leading #).' },
      ...PAGINATION_PARAMS,
      NSFW_PARAM
    ]
  },
  {
    method: 'GET',
    path: '/api/u/{handle}/images',
    summary: "A single user's image feed.",
    tags: ['users'],
    params: [
      { name: 'handle', in: 'path', required: true, type: 'string', description: 'User handle.' },
      ...PAGINATION_PARAMS,
      NSFW_PARAM
    ]
  }
];

// Compact machine-readable index returned by GET /api.
export function buildApiIndex() {
  return {
    name: SITE_NAME,
    version: pkg.version,
    description: 'Public read API for the pix.fish image gallery.',
    openapi: '/api/openapi.json',
    endpoints: API_ENDPOINTS.map((e) => ({
      method: e.method,
      path: e.path,
      summary: e.summary,
      params: (e.params ?? []).map((p) => p.name)
    }))
  };
}

// Projects the catalog into a valid OpenAPI 3.1 document.
export function buildOpenApiDoc() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const e of API_ENDPOINTS) {
    const parameters = (e.params ?? []).map((p) => ({
      name: p.name,
      in: p.in,
      required: p.in === 'path' ? true : Boolean(p.required),
      description: p.description,
      schema: { type: p.type ?? 'string' }
    }));
    const op = {
      summary: e.summary,
      tags: e.tags,
      parameters,
      responses: {
        '200': { description: 'Success' },
        '404': { description: 'No matching image / resource' }
      }
    };
    paths[e.path] = { ...(paths[e.path] ?? {}), [e.method.toLowerCase()]: op };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: `${SITE_NAME} public API`,
      version: pkg.version,
      description: 'Public read API for the pix.fish image gallery. Random-image endpoints and the core gallery read surface.'
    },
    servers: [{ url: SITE_URL }],
    tags: [
      { name: 'random', description: 'Random-image endpoints.' },
      { name: 'images', description: 'Gallery images.' },
      { name: 'discovery', description: 'Search and color discovery.' },
      { name: 'users', description: 'Per-user galleries.' }
    ],
    paths
  };
}
