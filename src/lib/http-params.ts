// Tiny shared helpers for parsing query-string params in route handlers.
// Extracted so the three gallery-feed routes (/api/images,
// /api/u/[handle]/images, /api/color/[hex]/images) don't drift on
// pagination/NSFW/basement resolution.

import { readShowNsfwCookie } from '@/lib/nsfw';
import { readBasementCookie } from '@/lib/basement';

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

// Basement flag resolution. No query-string override -- the basement gate
// is stricter than NSFW and should only ever be unlocked via the cookie
// (which requires the unlock ritual). Admin tooling reads the cookie too.
export async function resolveIncludeBasement(): Promise<boolean> {
  return readBasementCookie();
}
