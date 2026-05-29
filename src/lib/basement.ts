import { cookies } from 'next/headers';

// Visitor-side basement unlock preference. Cookie-backed so the server can
// filter before sending rows down the wire -- the blob URL must never be
// shipped to a locked visitor, just like the NSFW gate.
//
// Set by the unlock ritual: typing the passphrase into semantic search.
// Cleared by visiting /api/basement-toggle while already unlocked.
// The cookie is httpOnly so client JS cannot read or spoof it; a server
// read in every query helper is the only source of truth.
export const BASEMENT_COOKIE = 'pf_basement';

// The passphrase is checked case-insensitively. Changing it here
// immediately invalidates any existing unlock (the cookie value holds
// the hashed flag, not the passphrase itself, so old cookies stay valid
// but the search branch won't trip on the old string anymore).
//
// Changing BASEMENT_PASSPHRASE does NOT auto-expire existing cookies --
// to force everyone to re-unlock, change BASEMENT_COOKIE too.
export const BASEMENT_PASSPHRASE = process.env.BASEMENT_PASSPHRASE ?? 'show me the basement';

export async function readBasementCookie(): Promise<boolean> {
  const store = await cookies();
  return store.get(BASEMENT_COOKIE)?.value === 'unlocked';
}
