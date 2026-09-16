#!/usr/bin/env bash
set -euo pipefail

# Deploys pix.fish onto this host from the current branch of the checkout at
# $APP_DIR. Run as root (or via sudo) -- it needs to control the systemd
# units directly; the git/bun/build steps drop to the pixfish user so
# everything they touch keeps that ownership.

APP_DIR="/srv/pixfish"
APP_USER="pixfish"
BUN="/usr/local/bin/bun"
HEALTH_URL="http://127.0.0.1:3000/"
HEALTH_RETRIES=15
HEALTH_DELAY_SECONDS=2

step=""
web_stopped=""
fail() {
	echo "[deploy] FAILED at step: ${step}" >&2
	exit 1
}
log() {
	step="$1"
	echo "[deploy] ${step}"
}

# Without this, a failed build leaves the site down: we stop pixfish-web before
# building (see below), and every exit path from that point to the restart is an
# error path. Bringing the unit back on the way out means a broken deploy costs
# the build's duration of downtime rather than lasting until somebody notices.
# It may come back on the previous build or fail to start if `next build` left
# .next half-written, so the health check below is still what tells you whether
# the site is actually serving -- but trying is strictly better than not.
restore_web_on_failure() {
	local code=$?
	if [ "$code" -ne 0 ] && [ -n "$web_stopped" ]; then
		echo "[deploy] deploy failed with pixfish-web stopped; attempting to restart it" >&2
		systemctl start pixfish-web || echo "[deploy] could not restart pixfish-web -- SITE IS DOWN" >&2
	fi
	exit "$code"
}
trap restore_web_on_failure EXIT

if [ "$(id -u)" -ne 0 ]; then
	echo "[deploy] must run as root (needs systemctl start/stop on pixfish-web/pixfish-worker)" >&2
	exit 1
fi

cd "$APP_DIR"

log "pulling latest git state"
sudo -u "$APP_USER" git pull || fail

log "installing dependencies (bun install --frozen-lockfile)"
sudo -u "$APP_USER" "$BUN" install --frozen-lockfile || fail

# `next build` compiles 50+ pages and 100+ route handlers (see CLAUDE.md) and
# is memory-hungry in its own right. Doing that while pixfish-web is also
# live and serving traffic means both compete for the same 4GB, and on this
# box that contention is what actually OOMs the build rather than the build
# alone -- so the running server comes down first, deliberately, before the
# build starts. The site is briefly down for the build's duration; there is
# no blue/green slot on a single VPS.
log "stopping pixfish-web before build"
systemctl stop pixfish-web || fail
web_stopped=1

log "building (bun run build)"
sudo -u "$APP_USER" "$BUN" run build || fail

log "restarting pixfish-web"
systemctl restart pixfish-web || fail
web_stopped=""

log "restarting pixfish-worker"
systemctl restart pixfish-worker || fail

log "health check"
healthy=""
for _ in $(seq 1 "$HEALTH_RETRIES"); do
	if curl -fsS -o /dev/null "$HEALTH_URL"; then
		healthy=1
		break
	fi
	sleep "$HEALTH_DELAY_SECONDS"
done

if [ -z "$healthy" ]; then
	total_wait=$((HEALTH_RETRIES * HEALTH_DELAY_SECONDS))
	echo "[deploy] FAILED at step: health check -- ${HEALTH_URL} did not return 200 within ${total_wait}s of restart" >&2
	echo "[deploy] check: journalctl -u pixfish-web -n 100 --no-pager" >&2
	exit 1
fi

echo "[deploy] complete"
