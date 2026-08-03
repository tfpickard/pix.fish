# Rate limiting

Three layers, cheapest-to-defend first. They are complementary, not
alternatives -- the first is the only one that stops a flood before it costs
anything, and the only one that is configured outside this repo.

## 1. Vercel WAF (edge, global, not in this repo)

This is the layer that actually protects the bill. A WAF rate-limit rule is
evaluated on Vercel's edge network *before* any function is invoked, and its
counters are global rather than per-instance. Nothing in this repo can do
either of those things.

Configure it in the dashboard (Project -> Firewall -> Custom Rules) or with the
CLI. `vercel` is already a devDependency, so:

```sh
bunx vercel login
bunx vercel link            # pick the pix-fish project
```

A baseline pair of rules -- a generous cap on page traffic and a tighter one on
the API:

```sh
# Pages: 300 requests / minute / IP. A human browsing the gallery stays well
# under this; the flood that motivated these rules ran ~46 req/s to `/`.
bunx vercel firewall rules add "Rate limit pages" \
  --condition '{"type":"path","op":"pre","value":"/"}' \
  --action rate_limit \
  --rate-limit-window 60 \
  --rate-limit-requests 300 \
  --rate-limit-keys ip \
  --rate-limit-action deny --yes

# API: 120 requests / minute / IP.
bunx vercel firewall rules add "Rate limit API" \
  --condition '{"type":"path","op":"pre","value":"/api"}' \
  --action rate_limit \
  --rate-limit-window 60 \
  --rate-limit-requests 120 \
  --rate-limit-keys ip \
  --rate-limit-action deny --yes
```

Order matters: rules are evaluated top to bottom, so put the narrower `/api`
rule above the catch-all `/` rule.

```sh
bunx vercel firewall rules reorder "Rate limit API" --first --yes
bunx vercel firewall rules list --expand
```

Cron needs its own rule, because the `/api` rule above would otherwise throttle
it and a throttled drain silently stops the job queue. Give it a generous limit
rather than a `bypass`:

```sh
bunx vercel firewall rules add "Rate limit cron" \
  --condition '{"type":"path","op":"pre","value":"/api/cron"}' \
  --action rate_limit \
  --rate-limit-window 60 \
  --rate-limit-requests 20 \
  --rate-limit-keys ip \
  --rate-limit-action deny --yes
bunx vercel firewall rules reorder "Rate limit cron" --first --yes
```

Deliberately not `--action bypass`. These are public URLs, and a path-keyed
bypass exempts *everyone* who requests them, not just Vercel Cron -- which
hands an attacker a prefix with no WAF layer at all. Vercel Cron fires these
once a minute, so 20/min is far above real use while still capping abuse. The
edge limiter (layer 2) makes the same distinction in code: it skips the limiter
only for a request that actually carries the `CRON_SECRET` bearer token.

Rules are staged as drafts; publish them from the dashboard or with
`bunx vercel firewall publish`.

Two adjacent switches worth knowing about:

- **Attack Challenge Mode** -- `bunx vercel firewall attack-mode enable
  --duration 6h`. Challenges every visitor while letting verified crawlers
  through. This is the emergency lever during an active flood, not a standing
  configuration.
- **`--rate-limit-keys ja4`** -- keys on the TLS fingerprint instead of the IP.
  Better against a flood spread across many addresses, since a single client
  stack keeps one fingerprint.

Rate-limit rules are a paid-plan feature. If the project is on Hobby, the
`deny` and `challenge` actions are still available for blocking a specific
user agent or ASN outright, and layer 2 below still applies.

## 2. Edge middleware (`src/middleware.ts`, `src/lib/edge-rate-limit.ts`)

A per-IP fixed-window counter that runs in middleware, before the page renders.
It cannot stop the request from reaching Vercel, but it does stop it from
reaching the RSC render and the Postgres queries behind it -- which is where the
cost of a hammered `/` actually lives.

- Default 200 requests / minute / IP. Override with `RATE_LIMIT_RPM`.
- `RATE_LIMIT_DISABLED=1` turns the gate off without a deploy.
- `/api/auth/*` gets a separate 60/min bucket, so a client that has spent its
  page allowance during a flood can still finish an OAuth callback rather than
  being stranded on a 429 it cannot retry past.
- `/api/cron/*` skips the limiter **only** when the request carries the
  `CRON_SECRET` bearer token. Exempting the path itself would let anyone
  hammer a public URL into unlimited Node invocations that load the whole
  worker dependency graph before returning 403.
- The matcher's exclusion list is an explicit inventory of `public/` plus
  Next's build output, not a file-extension pattern. `/anything.png` matches no
  static file but still resolves through `src/app/[slug]/page.tsx`, so an
  extension rule would leave a family of database-backed paths uncounted. Add
  to the list when you add to `public/`.

The counters are module-scope state in one edge instance. Vercel runs many
instances across many regions, so a client spread across regions gets roughly
`limit x instances it lands on`. That is why layer 1 is not optional.

## 3. Per-action limits (`src/lib/rate-limit.ts`)

The pre-existing sliding-window limiter, called inside Node route handlers and
keyed per action and IP hash (`comment:<hash>`, `react:<hash>`, ...). It is
about abuse of a specific feature -- 3 comments per 10 minutes -- not about
traffic volume, and it runs after the invocation is already paid for.

## Note on `/`

`/` is `force-dynamic` with `revalidate = 0`, so every hit is a full render
plus its Postgres reads. Rate limiting caps how many of those a single client
can trigger; it does not make them cheaper. If sustained legitimate traffic is
the problem rather than one abusive client, a short `s-maxage` on the anonymous,
unfiltered variant of `/` is the bigger lever -- but it interacts with the NSFW
cookie, the per-request random haiku, and the sort seed, so it is a real change
rather than a config tweak.
