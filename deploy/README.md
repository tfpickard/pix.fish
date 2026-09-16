# pix.fish VPS deployment

Debian/Ubuntu, single 4GB VPS, behind Cloudflare (free tier). Database is
external Neon Postgres. Images live in Cloudflare R2, served from
`cdn.pix.fish` -- not covered here. This directory holds everything else:
the systemd units for the web server and worker, the cron replacements, the
Caddy reverse proxy config, and the deploy script.

## Layout on the host

```
/srv/pixfish                  app checkout (owned by pixfish:pixfish)
/etc/pixfish.env              secrets and config, mode 600, owned by pixfish
/etc/systemd/system/pixfish-*.{service,timer}
/etc/caddy/Caddyfile
```

## 1. Create the user and directories

```sh
useradd --system --create-home --home-dir /srv/pixfish --shell /usr/sbin/nologin pixfish
mkdir -p /srv/pixfish
chown pixfish:pixfish /srv/pixfish
```

Clone the repo as that user (set up deploy key / HTTPS credentials for
`pixfish` first, however you normally do that):

```sh
sudo -u pixfish git clone <repo-url> /srv/pixfish
```

## 2. Install bun system-wide

The units in this directory hardcode `/usr/local/bin/bun` -- not
`~/.bun/bin/bun`, which the non-root `pixfish` user (a service account with
no real home directory access pattern) can't rely on, and not
`/root/.bun/bin/bun`, which it can't reach at all. Install once, as root,
pointed at `/usr/local`:

```sh
curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash
bun --version   # confirm /usr/local/bin/bun resolves
```

If you'd rather pin a specific bun version to match what CI/dev use, check
that before wiring up cron -- a bun upgrade that changes `bun install`'s
resolution could make a live deploy diverge from what was tested.

## 3. `/etc/pixfish.env`

Holds Neon's `POSTGRES_URL`, `AUTH_SECRET`, R2 credentials, and the AI
provider keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `VOYAGE_API_KEY`, X
dispatch OAuth 1.0a creds, `CRON_SECRET`, etc -- see `.env.example` at the
repo root for the full set). It is read by every unit below via
`EnvironmentFile=`.

```sh
touch /etc/pixfish.env
chown pixfish:pixfish /etc/pixfish.env
chmod 600 /etc/pixfish.env
$EDITOR /etc/pixfish.env
```

600 and owned by `pixfish`, not root -- systemd reads `EnvironmentFile=` as
root before dropping privileges to `User=pixfish`, so root-readable is
sufficient for the units, but there's no reason for any other account on the
box to be able to read database credentials and provider keys, so lock it
to the one account that needs it.

## 4. Install the systemd units

```sh
cp /srv/pixfish/deploy/pixfish-*.service /srv/pixfish/deploy/pixfish-*.timer /etc/systemd/system/
systemctl daemon-reload

systemctl enable --now pixfish-web
systemctl enable --now pixfish-worker

systemctl enable --now pixfish-cron-universe.timer
systemctl enable --now pixfish-cron-characters.timer
systemctl enable --now pixfish-cron-dispatch.timer
```

Do not enable the `.service` half of the three cron pairs directly -- they
are `Type=oneshot` and only meant to be fired by their matching `.timer`.
There is deliberately no timer for the old `/api/cron/jobs` minutely drain;
`pixfish-worker` replaces that with an always-on process.

Confirm the timers landed on the schedule you expect:

```sh
systemctl list-timers 'pixfish-*'
```

## 5. Install Caddy and point it at `deploy/Caddyfile`

Debian/Ubuntu, official apt repo:

```sh
apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt update
apt install -y caddy
```

Then:

```sh
cp /srv/pixfish/deploy/Caddyfile /etc/caddy/Caddyfile
systemctl reload caddy
```

In Cloudflare's DNS, `pix.fish` and `www.pix.fish` are proxied (orange
cloud) A/AAAA records at this VPS; `cdn.pix.fish` points at R2 and is not
this Caddyfile's concern. Set Cloudflare's SSL/TLS mode to **Full (strict)**
-- Caddy's automatic TLS here secures the edge-to-origin hop, and
"Flexible" would leave that hop in plaintext despite the padlock the
visitor sees.

The Cloudflare IP list embedded in `Caddyfile` (`trusted_proxies static
...`) is what lets Caddy trust the `CF-Connecting-IP` header instead of
seeing every visitor as the Cloudflare edge. Re-pull it from
<https://www.cloudflare.com/ips/> periodically -- there's no alert for a
stale list, it just quietly stops covering new edge ranges.

## 6. The 4GB build caveat

`next build` on this repo (50+ pages, 100+ route handlers) is memory-heavy.
Doing it while `pixfish-web` is also serving traffic means the build
competes with the live server for the same 4GB, and that contention is what
actually causes an OOM here -- not the build in isolation. `deploy/deploy.sh`
stops `pixfish-web` before building for exactly this reason; don't run
`bun run build` by hand on this box with the service still up.

Provision swap as insurance regardless -- a build that's merely slow because
it's swapping is recoverable; one that gets OOM-killed mid-compile is not,
and leaves a half-written `.next/`:

```sh
fallocate -l 4G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

## 7. Deploying

```sh
/srv/pixfish/deploy/deploy.sh
```

Run as root (it needs `systemctl`). It pulls, installs deps, stops
`pixfish-web`, builds, restarts both services, then polls `/` until it
returns 200 or gives up and exits non-zero. Re-running it after a failure is
safe -- every step is idempotent (`git pull`, `bun install`, a `systemctl
stop`/`restart` on an already-stopped/running unit all no-op or converge).

## Troubleshooting

Upload has no caption / enrichment looks stuck:

```sh
journalctl -u pixfish-worker -f
```

That's where enrichment, reprocess, UMAP, webhook, and backup jobs actually
run now -- there's nothing to check in the web service's logs for a stuck
job.

Web server not responding:

```sh
journalctl -u pixfish-web -n 200 --no-pager
systemctl status pixfish-web
```

Cron replacements didn't fire, or fired at the wrong time:

```sh
systemctl list-timers 'pixfish-*'
journalctl -u pixfish-cron-dispatch.service -n 50 --no-pager
```

`list-timers` shows next/last elapse in local time by default; the units
themselves are pinned `OnCalendar=... UTC`, so if the box's local timezone
isn't UTC, mentally convert before concluding something's wrong.

Worker OOM-killed or missing:

```sh
journalctl -u pixfish-worker | grep -i 'killed\|oom'
systemctl show pixfish-worker -p MemoryMax -p MemoryCurrent
```

If it's genuinely running out of room inside its 1500M cap during a normal
UMAP recompute (not a runaway), that's a signal the corpus has grown enough
to need the cap raised -- raise `MemoryMax` in `pixfish-worker.service`
deliberately rather than dropping the limit, since the whole point of the
cap is that the worker OOMs itself instead of taking `pixfish-web` down with
it.

Caddy not proxying / TLS not issuing:

```sh
systemctl status caddy
journalctl -u caddy -n 100 --no-pager
caddy validate --config /etc/caddy/Caddyfile
```
