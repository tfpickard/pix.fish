import { cookies } from 'next/headers';

// Visitor-side NSFW preference. Cookie-backed so the server can filter
// before sending the row down the wire -- defaulting client-side to
// "default-hide with CSS blur" would still ship the URL/blob to the
// browser, which the public-by-default model wants to avoid.
//
// Three states stored in `pf_show_nsfw`:
//   missing / 'false'  -> 'hide'    (default: exclude NSFW rows)
//   'true'             -> 'include' (show all rows)
//   'only'             -> 'only'    (show only NSFW rows)
export const SHOW_NSFW_COOKIE = 'pf_show_nsfw';

// The three NSFW filter modes used throughout the query layer.
export type NsfwMode = 'hide' | 'include' | 'only';

export async function readNsfwMode(): Promise<NsfwMode> {
  const store = await cookies();
  const val = store.get(SHOW_NSFW_COOKIE)?.value;
  if (val === 'true') return 'include';
  if (val === 'only') return 'only';
  return 'hide';
}

// Backward-compat wrapper for callers that only need include/hide.
export async function readShowNsfwCookie(): Promise<boolean> {
  const mode = await readNsfwMode();
  return mode !== 'hide';
}
