// Tiny shared helpers for parsing query-string params in route handlers.
// Extracted so the three gallery-feed routes (/api/images,
// /api/u/[handle]/images, /api/color/[hex]/images) don't drift on
// pagination/NSFW resolution.

import { readShowNsfwCookie } from '@/lib/nsfw';

export function parseIntParam(raw: string | null, fallback: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

// Query-string override beats the cookie. Mirrors the previous inline
// resolution that lived in three route handlers: explicit ?include_nsfw=1
// (or =true) forces inclusion regardless of the visitor cookie; absent
// query falls back to the cookie default (off).
export async function resolveIncludeNsfw(raw: string | null): Promise<boolean> {
  if (raw === '1' || raw === 'true') return true;
  return readShowNsfwCookie();
}
