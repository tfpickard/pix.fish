import { cookies } from 'next/headers';

// Visitor-side NSFW preference. Cookie-backed so the server can filter
// before sending the row down the wire -- defaulting client-side to
// "default-hide with CSS blur" would still ship the URL/blob to the
// browser, which the public-by-default model wants to avoid.
//
// Set by toggling the `Show NSFW` switch in the nav bar (writes a
// `pf_show_nsfw=true` cookie). Defaults to false; any explicit "false" or
// missing cookie hides NSFW.
export const SHOW_NSFW_COOKIE = 'pf_show_nsfw';

export async function readShowNsfwCookie(): Promise<boolean> {
  const store = await cookies();
  return store.get(SHOW_NSFW_COOKIE)?.value === 'true';
}
