# Cutover runbook: Vercel to R2 + VPS

Operator guide for moving pix.fish off Vercel. `deploy/README.md` covers host
setup in detail; this is the ordering and the decision points.

The shape of the plan: everything reversible happens first, over days, while
Vercel keeps serving production. The irreversible moment is one DNS record and
one SQL rewrite, and both have a way back.

**Phases 0 to 4 change nothing about the live site.** You can stop at the end of
any of them and walk away.

---

## Phase 0: DNS to Cloudflare (do this first, today)

This is first because it is a hard prerequisite, not just convenience: **R2's
public custom domain can only attach to a zone already in your Cloudflare
account.** `cdn.pix.fish` cannot exist until `pix.fish` is on Cloudflare
nameservers. Nameserver changes also take up to 48h to propagate, so starting
now takes that delay off the cutover window entirely.

1. Add `pix.fish` to Cloudflare (free plan). It imports your existing records.
2. **Check the imported records against your current DNS before switching.**
   Cloudflare's scan misses records sometimes. Pay attention to MX and any TXT
   used for mail (SPF/DKIM/DMARC): losing those silently breaks email.
3. Update the nameservers at your registrar.
4. Leave every record **DNS-only (grey cloud)** for now. Cloudflare does nothing
   but answer DNS queries; Vercel serves exactly as it does today.
5. Once propagated, set the TTL on the apex and `www` records to the lowest
   Cloudflare offers. At cutover you want the old address to stop being cached
   quickly.

**Do not turn the orange cloud on yet, and do not point anything at the VPS.**

Proxying Cloudflare in front of Vercel would get you CDN relief a week early,
and it is tempting, but Vercel manages its own TLS certificate for the domain
and that provisioning can fail behind a proxy. A redirect loop or an expired
cert on your live site is not worth an interim week. The orange cloud goes on at
cutover, when the origin is your own Caddy, which is built for it.

**Rollback:** point the nameservers back at your old provider.

**Note on OAuth:** because the domain does not change, your GitHub, Google and
Apple OAuth apps need no changes at all. `AUTH_URL` stays `https://pix.fish`.
This is the main reason to keep the domain rather than move to a new one.

---

## Phase 1: R2 bucket

Once Phase 0 has propagated.

1. Cloudflare dashboard, R2, create a bucket. Pick a location hint near your
   VPS.
2. Bucket, Settings, Public access, **Connect Domain**: `cdn.pix.fish`.
   Cloudflare creates the DNS record itself. Wait for the cert to issue.
3. Account, R2, **Manage API Tokens**, create a token with **Object Read &
   Write**, scoped to just this bucket.
4. Note the five values you need:
   - `R2_ACCOUNT_ID` -- your Cloudflare account ID, in the dashboard URL
   - `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` -- from the token you just made
   - `R2_BUCKET` -- the bucket name
   - `R2_PUBLIC_BASE` -- `https://cdn.pix.fish`, **no trailing slash**

Confirm: `curl -I https://cdn.pix.fish/anything` should return 404 from
Cloudflare, not a DNS error. A 404 means the domain is wired up correctly.

**Rollback:** delete the bucket. Nothing references it yet.

---

## Phase 2: copy the objects (the long one)

Non-destructive. Writes nothing to the database. Vercel keeps serving
throughout. Start it as early as you can, because it is the longest step and
everything else can happen while it runs.

Run it from anywhere with network access and the database URL -- your laptop is
fine, the VPS is fine.

```sh
git fetch origin && git checkout feature/serene-goldberg-hb6qgc
bun install

export POSTGRES_URL='...'          # the Neon URL you already use
export R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=...
export R2_BUCKET=... R2_PUBLIC_BASE='https://cdn.pix.fish'

bun scripts/migrate-blobs-to-r2.ts            # dry run, costs no egress
bun scripts/migrate-blobs-to-r2.ts --apply    # the real copy
```

The dry run probes with HEAD rather than GET, so it tells you the true
copy/skip/fail counts without pulling a single byte through Vercel's egress
meter. Read its output before committing to `--apply`.

Run it in tmux. It is resumable: a re-run HEAD-checks R2 and skips what is
already there, so an interrupted copy costs nothing to restart.

**Re-run until it reports zero failures and exits 0.** Phase 5 depends on that.

A handful of persistent `source 404` failures usually means rows pointing at
objects that no longer exist in Vercel Blob. Those images are already broken in
production today. Note the ids and move on; they will simply stay broken.

**Rollback:** none needed. Nothing has changed.

---

## Phase 3: build the VPS

Follow `deploy/README.md`. In short: create the `pixfish` user, install bun to
`/usr/local`, clone the repo, write `/etc/pixfish.env` (chmod 600), install the
systemd units and timers, install Caddy.

Two things that will bite otherwise:

- **Provision 4GB of swap before your first build.** 51 pages and 101 route
  handlers is a memory-hungry `next build` and 4GB of RAM is tight. Swap is
  insurance, not a performance plan.
- **`R2_PUBLIC_BASE` must be present at build time**, not just runtime.
  `next.config.mjs` derives the image optimizer's host allowlist from it.

Point `/etc/pixfish.env` at the **live** database. It is the same data; the app
is simply not serving the public yet.

Start both units. Check them:

```sh
systemctl status pixfish-web pixfish-worker
journalctl -u pixfish-worker -f
systemctl list-timers 'pixfish-*'
```

**Rollback:** `systemctl stop pixfish-web pixfish-worker`. Nothing points at
this box yet.

---

## Phase 4: rehearse against production data

The single most valuable step, and the reason a one-shot cutover is safe.

Reach the VPS directly, bypassing DNS. On your laptop:

```sh
# /etc/hosts
<vps-ip>  pix.fish www.pix.fish
```

Then exercise the app in a browser. Vercel is still serving everyone else.

Work through these specifically. They map to the parts of this migration that
have never run for real:

| Exercise | What it proves |
|---|---|
| Browse the gallery, open an image | Reads work under the new database driver |
| Sign in | Auth.js and the session cookie work through Caddy |
| Upload a photo | `put` with a Buffer; job enqueues; caption appears |
| Watch `journalctl -u pixfish-worker -f` during that | The worker claims and drains |
| Run a search | Embeddings path intact |
| `/admin/jobs`, trigger a backup export, download it | **Streamed upload.** The likeliest thing to be wrong. Watch memory with `systemd-cgtop` |
| Delete an image that has derivatives and crops | **Mixed key/URL delete** in one call |
| `/admin/map`, recompute UMAP | A job running past 60s, which Vercel could never do |
| `systemctl restart pixfish-worker` mid-job | Graceful shutdown, no stuck `processing` rows |
| Post an anonymous comment | `IP_HASH_SALT` is set; geo headers resolve or null out cleanly |

Images will still load from Vercel Blob at this stage, because the database
still holds those URLs. That is expected. Phase 5 is what moves them.

**Remove the `/etc/hosts` entry when you are done.**

**Rollback:** stop the units, delete the hosts entry.

---

## Phase 5: the cutover window

Everything before this was reversible by doing nothing. This is the part with
actual steps back, so read each one before running it.

Budget an hour. Pick a quiet time.

### 5a. Stop the Vercel cron

In the Vercel dashboard, pause the project or disable the crons. Two workers
draining the same queue is not corrupting (the claim uses `FOR UPDATE SKIP
LOCKED`) but it makes the logs impossible to read, and the once-a-day dispatch
claim gets confusing.

### 5b. Rewrite the URLs

```sh
bun scripts/rewrite-blob-urls.ts            # dry run
bun scripts/rewrite-blob-urls.ts --apply
```

The dry run probes a sample of the new R2 URLs first and refuses to proceed if
any 404. That is the check that catches an incomplete Phase 2.

`--apply` writes `blob-url-rollback-<timestamp>.json` **before** touching a
single row. **Keep that file.** Copy it somewhere off the box.

### 5c. Confirm the VPS now serves from R2

Put the `/etc/hosts` entry back, reload the gallery, and check in devtools that
image requests go to `cdn.pix.fish`. Then remove the entry again.

### 5d. Flip DNS

In Cloudflare, point the apex and `www` at the VPS IP, and **turn the orange
cloud on**. Then set SSL/TLS mode to **Full (strict)** -- Caddy has a real
certificate, and "Flexible" would cause a redirect loop.

Watch `journalctl -u pixfish-web -f` as traffic arrives.

### 5e. Verify with real traffic

Load the site from a device that is not on your network. Sign in. Upload
something. Post a comment. Check `/admin/jobs` for anything red.

### Rollback from any point in Phase 5

1. `bun scripts/rewrite-blob-urls.ts --rollback blob-url-rollback-<ts>.json`
2. Point Cloudflare back at Vercel, grey cloud
3. Unpause the Vercel project

Vercel Blob still holds every object, so this genuinely works. That is why
Phase 6 waits.

---

## Phase 6: after

**Immediately:**

- Cloudflare, Security: turn on **Bot Fight Mode**.
- Add one rate-limiting rule (the free plan includes one). Put it on the
  expensive paths, not the whole site: `/api/search` is the one that spends real
  money, since every hit is an embedding call.
- Cache rules: a short edge TTL on `/`, `/[slug]` and `/u/*`. Even 60 seconds
  collapses a crawler swarm into one origin hit per URL per minute. **This is
  the actual fix for what was driving your bill**, and it only became possible
  once Cloudflare was in front of the origin.

**After a week of stability:**

- Cancel the Vercel project.
- Only then delete the Vercel Blob store. It is your rollback path until you do,
  and it costs little to keep for another week.

**Keep an eye on:**

- `journalctl -u pixfish-worker` for the first few days. Job failures surface at
  `/admin/jobs`.
- `systemctl list-timers 'pixfish-*'` after the first 24h, confirming all three
  fired.
- The first scheduled X dispatch. It runs unattended and is the thing least
  exercised by rehearsal.

---

## While you are still on Vercel

Two things worth doing today that do not wait for any of the above:

- **Vercel's firewall.** Block the worst crawler user-agents, or rate-limit at
  the edge. `robots.ts` already disallows `/api/`, which handles the polite
  ones; this is for the rest.
- **Check what is actually costing you.** The Vercel usage dashboard broken down
  by route tells you whether this is image bandwidth (which R2 fixes completely)
  or function invocations on `/[slug]` (which the Phase 6 cache rules fix). Good
  to know which before you are relying on the fix.
