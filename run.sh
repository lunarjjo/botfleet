#!/usr/bin/env bash
# botfleet — download-and-run launcher.
#
#   ./run.sh            full local demo: a throwaway vanilla server + the web
#                       console + three pre-seeded units. one command, zero
#                       config. Ctrl-C stops everything.
#   ./run.sh console    just the web console (point units at any server from
#                       the dashboard or REST).
#
# requirements: node >= 20, curl, and java for demo mode
#   (java 25+  -> demo runs minecraft 26.2
#    java 21-24 -> demo runs minecraft 1.21.8
#    override with MC_VERSION if you want a specific one)
#
# env knobs (all optional):
#   PORT        console port            (default 3000)
#   MC_PORT     demo server port        (default 25565)
#   MC_VERSION  force a vanilla version (default: picked from your java)
#   MC_DIR      demo server directory   (default "mcserver")
#   MC_SEED     world seed              (default "botfleet-demo")
#   MC_LEVEL    terrain shape: minecraft\:flat for superflat, empty = default
#   MC_HEAP     java heap cap           (default 1024M)
#   JAVA_BIN    java executable         (default: java from PATH)
set -euo pipefail
cd "$(dirname "$0")"

MODE="${1:-demo}"
PORT="${PORT:-3000}"
MC_PORT="${MC_PORT:-25565}"
MC_DIR="${MC_DIR:-mcserver}"
MC_SEED="${MC_SEED:-botfleet-demo}"
MC_LEVEL="${MC_LEVEL:-}"   # empty = server default terrain; or minecraft\:flat
MC_HEAP="${MC_HEAP:-1024M}"
JAVA_BIN="${JAVA_BIN:-java}"

c_info ()  { printf '\033[1;34m[botfleet]\033[0m %s\n' "$*"; }
c_ok ()    { printf '\033[1;32m[botfleet]\033[0m %s\n' "$*"; }
c_err ()   { printf '\033[1;31m[botfleet]\033[0m %s\n' "$*" >&2; }
die ()     { c_err "$*"; exit 1; }

# ---------------------------------------------------------------- node check
NODE_MAJOR=$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || echo 0)
[ "$NODE_MAJOR" -ge 20 ] || die "node >= 20 required (found: $(node -v 2>/dev/null || echo none)). ubuntu: sudo apt install nodejs npm  (or use nvm)"
command -v curl >/dev/null || die "curl is required. ubuntu: sudo apt install curl"

# ------------------------------------------------------- dependencies check
if [ ! -d node_modules ]; then
  c_info "first run: installing node dependencies (a minute or two)…"
  npm install --no-audit --no-fund --loglevel=error
  c_ok "dependencies installed."
fi

port_busy () { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&- 3<&-; return 0; } || return 1; }

CONSOLE_PID=""
cleanup () {
  [ -n "$CONSOLE_PID" ] && kill "$CONSOLE_PID" 2>/dev/null || true
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  exit 0
}
trap 'cleanup' INT TERM

start_console () {
  if port_busy "$PORT"; then die "port $PORT is already in use — stop the other process or set PORT=xxxx ./run.sh"; fi
  c_ok "console starting on http://127.0.0.1:$PORT"
  PORT="$PORT" BOTS="$BOTS_SEED" node src/index.js &
  CONSOLE_PID=$!
  # poll instead of `wait`: a trapped signal only runs after the current
  # command finishes, so short sleeps keep the shutdown latency <= 1s
  while kill -0 "$CONSOLE_PID" 2>/dev/null; do sleep 1; done
}

if [ "$MODE" = "console" ]; then
  BOTS_SEED="[]"
  start_console
fi
[ "$MODE" = "demo" ] || die "unknown mode '$MODE' — use './run.sh demo' or './run.sh console'"

# ---------------------------------------------------------------- java check
JAVA_MAJOR=$("$JAVA_BIN" -version 2>&1 | head -1 | sed 's/^[^"]*"\([0-9]*\).*/\1/')
if [ -z "${JAVA_MAJOR:-}" ] || [ "$JAVA_MAJOR" -eq 0 ] 2>/dev/null; then
  c_err "demo mode needs java, which was not found."
  c_err "  ubuntu 22/24: sudo apt install openjdk-21-jre-headless   (demo will run minecraft 1.21.8)"
  c_err "  for minecraft 26.x: install a java 25+ jre and put it on PATH (or set JAVA_BIN=...)"
  c_err "  console-only still works: ./run.sh console"
  exit 1
fi
if [ -z "${MC_VERSION:-}" ]; then
  if [ "$JAVA_MAJOR" -ge 25 ]; then MC_VERSION=26.2; else MC_VERSION=1.21.8; fi
fi
c_info "java $JAVA_MAJOR detected -> demo server: minecraft $MC_VERSION"

# ------------------------------------------------------- fetch vanilla server
mkdir -p "$MC_DIR"
if [ ! -f "$MC_DIR/server.jar" ]; then
  c_info "downloading vanilla $MC_VERSION server (first run only)…"
  URL=$(curl -s https://piston-meta.mojang.com/mc/game/version_manifest_v2.json \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s).versions.find(x=>x.id===process.argv[1]);if(!v){process.exit(2)}console.log(v.url)})' "$MC_VERSION" \
    | xargs curl -s \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const u=JSON.parse(s).downloads.server.url;console.log(u)})') \
    || die "could not resolve the download for minecraft $MC_VERSION (check the version id)"
  curl -f -o "$MC_DIR/server.jar" "$URL" || die "server jar download failed"
  c_ok "server jar saved to $MC_DIR/server.jar"
fi

printf 'eula=true\n' > "$MC_DIR/eula.txt"
if [ ! -f "$MC_DIR/server.properties" ]; then
  cat > "$MC_DIR/server.properties" <<PROPS
online-mode=false
server-port=$MC_PORT
level-seed=$MC_SEED
generate-structures=false
view-distance=6
spawn-protection=0
sync-chunk-writes=false
motd=botfleet demo
max-players=8
white-list=false
PROPS
fi
# optional terrain shape: only write level-type when asked for — omitting the
# key lets every minecraft version pick its own default (normal terrain)
if [ -n "${MC_LEVEL:-}" ] && ! grep -q '^level-type=' "$MC_DIR/server.properties" 2>/dev/null; then
  printf 'level-type=%s\n' "$MC_LEVEL" >> "$MC_DIR/server.properties"
fi
# minecraft 26.x regenerates server.properties with white-list=true when the
# key is absent — keep our value alive across regenerations
if grep -q '^white-list=' "$MC_DIR/server.properties"; then
  sed -i "s/^white-list=.*/white-list=false/" "$MC_DIR/server.properties"
else
  printf 'white-list=false\n' >> "$MC_DIR/server.properties"
fi
if port_busy "$MC_PORT"; then die "port $MC_PORT is already in use — stop the other server or set MC_PORT=xxxx ./run.sh"; fi

# ------------------------------------------------------------- boot the server
c_info "starting demo server on port $MC_PORT (heap $MC_HEAP, first boot takes a while)…"
( cd "$MC_DIR" && exec "$JAVA_BIN" -Xms512M -Xmx"$MC_HEAP" -jar server.jar nogui ) &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT INT TERM

LOG="$MC_DIR/logs/latest.log"
DEADLINE=$(( $(date +%s) + 300 ))
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    c_err "the minecraft server exited early — its last log lines:"
    tail -n 15 "$LOG" 2>/dev/null || tail -n 15 "$MC_DIR"/logs/*.log 2>/dev/null || true
    exit 1
  fi
  if [ -f "$LOG" ] && grep -q 'Done (' "$LOG"; then break; fi
  sleep 2
done
if [ -f "$LOG" ] && grep -q 'Done (' "$LOG"; then
  c_ok "minecraft $MC_VERSION is up on 127.0.0.1:$MC_PORT"
else
  c_err "server did not report Done within 300s — check $LOG"
  exit 1
fi

# ------------------------------------------------------------ start the stack
BOTS_SEED="[
  {\"name\":\"Scout\",\"host\":\"127.0.0.1\",\"port\":$MC_PORT,\"version\":\"$MC_VERSION\"},
  {\"name\":\"Ranger\",\"host\":\"127.0.0.1\",\"port\":$MC_PORT,\"version\":\"$MC_VERSION\"},
  {\"name\":\"Relay\",\"host\":\"127.0.0.1\",\"port\":$MC_PORT,\"version\":\"$MC_VERSION\"}
]"
c_info "console: http://127.0.0.1:$PORT  — three units (Scout, Ranger, Relay) are connecting to the demo server."
c_info "click the radar to move a unit; select a unit then chat 'Scout, mine grass_block' in the console feed."
c_info "Ctrl-C stops the console and the demo server."
start_console
c_info "console stopped — stopping the demo server too."
