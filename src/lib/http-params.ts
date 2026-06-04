// Tiny shared helpers for parsing query-string params in route handlers.
// Extracted so the three gallery-feed routes (/api/images,
// /api/u/[handle]/images, /api/color/[hex]/images) don't drift on
// pagination/NSFW resolution.

import { readNsfwMode, type NsfwMode } from '@/lib/nsfw';

export type { NsfwMode };

export function parseIntParam(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

// Query-string ?include_nsfw= override beats the cookie.
//   '1' or 'true'  -> 'include'
//   'only'         -> 'only'
//   absent / other -> read the visitor cookie
export async function resolveNsfwMode(raw: string | null): Promise<NsfwMode> {
  if (raw === '1' || raw === 'true') return 'include';
  if (raw === 'only') return 'only';
  return readNsfwMode();
}

// Backward-compat alias for routes not yet migrated.
export async function resolveIncludeNsfw(raw: string | null): Promise<boolean> {
  const mode = await resolveNsfwMode(raw);
  return mode !== 'hide';
}
