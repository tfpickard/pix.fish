// The single list of routes BotID protects, shared by the client component in
// the root layout and referenced by the handlers that call checkBotId().
//
// BotID is not a general rate limiter and does not replace one. It answers "did
// a real browser session make this request", which only works for endpoints the
// browser calls directly -- the client script has to have run and attached a
// token. Everything here is therefore a browser-invoked POST that costs real
// money or creates durable state.
//
// Deliberately NOT protected:
//
// - `POST /api/images` (upload). `/api/share-target` handles the PWA share
//   intent by synthesizing a Request and calling the upload handler directly.
//   That inner request never passed through the browser fetch the client
//   script instruments, so it carries no token and a checkBotId() inside the
//   upload handler would 403 every share. Upload also already requires a
//   session, so abusing it means getting through OAuth or /api/register --
//   and /api/register is on this list.
// - `POST /api/images/:slug/reactions`. High-frequency and cheap: one row,
//   already capped at 10/min per IP hash and unique per (image, ip_hash).
//   checkBotId() is a network round trip, and paying it on every thumbs-up
//   would be felt in the UI to prevent a vote that the unique index already
//   collapses.
//
// If inbound API-token auth is ever wired up (the `api_keys` table exists but
// no handler verifies a token today), those requests will have no BotID token
// either and will need to bypass the check before the token path can work.
export const BOTID_PROTECTED_ROUTES = [
  // Anonymous and spends Anthropic tokens on every message -- the one endpoint
  // here where a bot costs money directly rather than just making a mess.
  { path: '/api/chat', method: 'POST' },
  // Account creation. Gating this is what keeps the upload path (session-only)
  // out of reach of a scripted signup.
  { path: '/api/register', method: 'POST' },
  // Anonymous comment posting: guests may submit without signing in, so the
  // only thing between a spam script and the moderation queue is the per-IP
  // throttle. The wildcard covers the image slug segment.
  { path: '/api/images/*/comments', method: 'POST' }
] as const;
