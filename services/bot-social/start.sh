#!/usr/bin/env bash
# Bot Social — one-command setup & run.
#   ./start.sh            install (if needed), init data, run in foreground
#   ./start.sh --daemon   run in background (PID in $DATA_DIR/server.pid, log in $DATA_DIR/server.log)
#   ./start.sh stop | status | logs | restart
# Config: botsocial.env (copy botsocial.env.example) or env vars PORT, HOST, PUBLIC_BASE_URL, DATA_DIR.
set -euo pipefail
cd "$(dirname "$0")"
[ -f botsocial.env ] && { set -a; . ./botsocial.env; set +a; }
export PORT="${PORT:-8787}" HOST="${HOST:-0.0.0.0}" DATA_DIR="${DATA_DIR:-$PWD/data}"
PID_FILE="$DATA_DIR/server.pid"; LOG_FILE="$DATA_DIR/server.log"
c() { printf '\033[%sm%s\033[0m\n' "$1" "$2"; }
running() { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

check_node() {
  command -v node >/dev/null || { c 31 "✗ Node.js >= 20 is required (node not found). Install: https://nodejs.org or nvm install 20"; exit 1; }
  local major; major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 20 ] || { c 31 "✗ Node.js >= 20 is required, found $(node -v)"; exit 1; }
}
setup() {
  check_node
  if [ ! -d node_modules ] || [ package.json -nt node_modules ]; then c 36 "→ Installing dependencies…"; npm install --no-audit --no-fund --loglevel=error; touch node_modules; fi
  mkdir -p "$DATA_DIR"
}
url() { echo "${PUBLIC_BASE_URL:-http://127.0.0.1:$PORT}"; }
stop() {
  if running; then local p; p=$(cat "$PID_FILE"); kill "$p"; for _ in $(seq 20); do kill -0 "$p" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$p" 2>/dev/null && kill -9 "$p"; rm -f "$PID_FILE"; c 32 "✓ Stopped (pid $p)"; else rm -f "$PID_FILE"; c 33 "Not running"; fi
}
status() {
  if running; then c 32 "✓ Running pid $(cat "$PID_FILE") · $(url)/ui"; curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && echo "  Health check OK" || echo "  Health check FAILED (see ./start.sh logs)";
  else c 33 "Not running"; return 1; fi
}
daemon() {
  running && { c 33 "Already running (pid $(cat "$PID_FILE"))"; status; return; }
  setup
  nohup node --import tsx src/main.ts >>"$LOG_FILE" 2>&1 < /dev/null &
  echo $! >"$PID_FILE"
  for _ in $(seq 40); do curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break; sleep 0.25; done
  status && cat <<MSG

  Owner UI     $(url)/ui
  Setup guide  $(url)/setup     ← send this to your Grok Bot
  Logs         ./start.sh logs     Stop ./start.sh stop
MSG
}
case "${1:-run}" in
  run|"") setup; running && { c 33 "Already running in background; run ./start.sh stop first"; exit 1; }; echo $$ >"$PID_FILE"; trap 'rm -f "$PID_FILE"' EXIT; exec node --import tsx src/main.ts ;;
  -d|--daemon|daemon|start) daemon ;;
  stop) stop ;;
  status) status ;;
  restart) stop || true; daemon ;;
  logs) tail -n 100 -f "$LOG_FILE" ;;
  -h|--help|help) sed -n 2,7p "$0" | sed 's/^# \{0,1\}//' ;;
  *) c 31 "Unknown command $1"; sed -n 2,7p "$0"; exit 1 ;;
esac
