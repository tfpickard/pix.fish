#!/usr/bin/env bash
# dev.sh -- control the pix.fish local dev server.
#
# Usage: ./dev.sh [-v|-vv|-vvv] {start|stop|restart|status|logs}
#
# Subcommands:
#   start    check env, launch `bun run dev` in background, wait for readiness
#   stop     kill the running dev server (via PID file + port fallback)
#   restart  stop + start
#   status   show whether a dev server is up and on which port
#   logs     tail the dev server log (ctrl-c to exit)
#
# Verbosity:
#   (none)   quiet; print final status lines only
#   -v       info:  commands, env file loaded, port chosen
#   -vv      debug: env var presence (values masked), PID lookups
#   -vvv     trace: set -x on the script itself
#
# Env:
#   .env.local is sourced automatically if present.
#   PORT defaults to 3000; override with PORT=4000 ./dev.sh start
#   Required vars (checked before 'start'): POSTGRES_URL, BLOB_READ_WRITE_TOKEN,
#     AUTH_SECRET, AUTH_URL, AUTH_GITHUB_ID, AUTH_GITHUB_SECRET,
#     OWNER_GITHUB_ID, ANTHROPIC_API_KEY
#   Optional: OPENAI_API_KEY

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

PID_FILE="$ROOT/.dev-server.pid"
LOG_FILE="$ROOT/.dev-server.log"
PORT="${PORT:-3000}"

VERBOSITY=0
CMD=""

# --------------------------------- args ------------------------------------
while (($#)); do
  case "$1" in
    -vvv) VERBOSITY=3; shift ;;
    -vv)  VERBOSITY=2; shift ;;
    -v)   VERBOSITY=1; shift ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    start|stop|restart|status|logs)
      CMD="$1"; shift ;;
    --)
      shift; break ;;
    -*)
      echo "unknown flag: $1" >&2
      exit 2 ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2 ;;
  esac
done

if [[ -z "$CMD" ]]; then
  echo "usage: $0 [-v|-vv|-vvv] {start|stop|restart|status|logs}" >&2
  exit 2
fi

if ((VERBOSITY >= 3)); then
  set -x
fi

info()  { ((VERBOSITY >= 1)) && printf '[info]  %s\n' "$*" >&2 || true; }
debug() { ((VERBOSITY >= 2)) && printf '[debug] %s\n' "$*" >&2 || true; }

# -------------------------------- env load ---------------------------------
ENV_FILE="$ROOT/.env.local"
if [[ -f "$ENV_FILE" ]]; then
  info "loading env from $ENV_FILE"
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
else
  debug "no .env.local file at $ENV_FILE"
fi

REQUIRED_VARS=(
  POSTGRES_URL
  BLOB_READ_WRITE_TOKEN
  AUTH_SECRET
  AUTH_URL
  AUTH_GITHUB_ID
  AUTH_GITHUB_SECRET
  OWNER_GITHUB_ID
  ANTHROPIC_API_KEY
)
OPTIONAL_VARS=(OPENAI_API_KEY)

mask() {
  local v="$1"
  local len=${#v}
  if ((len <= 8)); then
    printf '***'
  else
    printf '%s...(len=%d)' "${v:0:4}" "$len"
  fi
}

check_env() {
  local missing=()
  local v
  for v in "${REQUIRED_VARS[@]}"; do
    if [[ -z "${!v:-}" ]]; then
      missing+=("$v")
    else
      debug "env: $v=$(mask "${!v}")"
    fi
  done
  for v in "${OPTIONAL_VARS[@]}"; do
    if [[ -z "${!v:-}" ]]; then
      debug "env: $v is unset (optional)"
    else
      debug "env: $v=$(mask "${!v}")"
    fi
  done
  if ((${#missing[@]} > 0)); then
    echo "missing required env vars:" >&2
    printf '  - %s\n' "${missing[@]}" >&2
    echo >&2
    echo "Copy .env.example to .env.local and fill in the blanks." >&2
    exit 1
  fi
}

# -------------------------------- pid helpers ------------------------------
pid_alive() {
  local pid="${1:-}"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

read_pid() {
  if [[ -f "$PID_FILE" ]]; then
    tr -d '[:space:]' <"$PID_FILE"
  fi
}

port_in_use() {
  lsof -ti "tcp:$PORT" >/dev/null 2>&1
}

# -------------------------------- actions ----------------------------------
cmd_start() {
  check_env
  local pid
  pid="$(read_pid || true)"
  if pid_alive "$pid"; then
    echo "pix.fish dev already up (pid $pid) on http://localhost:$PORT"
    return 0
  fi
  if port_in_use; then
    echo "port $PORT is already in use by another process:" >&2
    lsof -i "tcp:$PORT" >&2 || true
    exit 1
  fi

  info "starting bun run dev on port $PORT"
  : >"$LOG_FILE"
  # Launch as a detached background process so closing this shell does not
  # take the server with it. Double fork via nohup + disown.
  (
    cd "$ROOT"
    nohup bun run dev >"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
    disown || true
  )
  local new_pid
  new_pid="$(read_pid || true)"
  debug "bun dev pid=$new_pid log=$LOG_FILE"

  # Wait for readiness. Time out at 60s.
  local tries=0
  until curl -sfm 2 "http://localhost:$PORT" -o /dev/null 2>/dev/null; do
    if ! pid_alive "$new_pid"; then
      echo "dev server exited during startup. last log lines:" >&2
      tail -n 30 "$LOG_FILE" >&2 || true
      exit 1
    fi
    if ((tries > 60)); then
      echo "dev server did not respond on http://localhost:$PORT within 60s" >&2
      echo "run: $0 logs" >&2
      exit 1
    fi
    tries=$((tries + 1))
    sleep 1
  done

  echo "pix.fish dev: up (pid $new_pid) on http://localhost:$PORT"
}

cmd_stop() {
  local pid
  pid="$(read_pid || true)"
  local stopped=0

  if pid_alive "$pid"; then
    info "stopping pid $pid"
    kill "$pid" 2>/dev/null || true
    local i
    for i in 1 2 3 4 5 6 7 8 9 10; do
      pid_alive "$pid" || break
      sleep 0.3
    done
    if pid_alive "$pid"; then
      info "pid $pid still alive, sending SIGKILL"
      kill -9 "$pid" 2>/dev/null || true
    fi
    stopped=1
  fi

  # If anything else is still bound to the port (orphaned child next-server),
  # clean it up so the next 'start' can bind cleanly.
  if port_in_use; then
    debug "port $PORT still bound; killing holders"
    lsof -ti "tcp:$PORT" | xargs -r kill 2>/dev/null || true
    sleep 0.5
    if port_in_use; then
      lsof -ti "tcp:$PORT" | xargs -r kill -9 2>/dev/null || true
    fi
    stopped=1
  fi

  rm -f "$PID_FILE"
  if ((stopped)); then
    echo "pix.fish dev: stopped"
  else
    echo "pix.fish dev: not running"
  fi
}

cmd_restart() {
  cmd_stop
  cmd_start
}

cmd_status() {
  local pid
  pid="$(read_pid || true)"
  if pid_alive "$pid"; then
    echo "pix.fish dev: up (pid $pid) on http://localhost:$PORT"
    return 0
  fi
  if port_in_use; then
    echo "pix.fish dev: not tracked by this script, but port $PORT is in use:"
    lsof -i "tcp:$PORT"
    return 0
  fi
  echo "pix.fish dev: not running"
}

cmd_logs() {
  if [[ ! -f "$LOG_FILE" ]]; then
    echo "no log file at $LOG_FILE (server hasn't been started yet)" >&2
    exit 1
  fi
  exec tail -n 200 -f "$LOG_FILE"
}

case "$CMD" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_restart ;;
  status)  cmd_status ;;
  logs)    cmd_logs ;;
esac
