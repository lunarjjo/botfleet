#!/usr/bin/env bash
# boots a throwaway vanilla minecraft server for the e2e check in test/live.js.
# requires java 21+. the server lands in ./server (gitignored) with a fixed
# superflat seed so runs are deterministic.
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION="${MC_VERSION:-1.21.8}"
DIR=server
HEAP="${MC_HEAP:-1024M}"

mkdir -p "$DIR"
cd "$DIR"

if [ ! -f server.jar ]; then
  echo "downloading vanilla $VERSION server…"
  URL=$(curl -s https://piston-meta.mojang.com/mc/game/version_manifest_v2.json \
    | python3 -c "import json,sys; m=json.load(sys.stdin); print(next(v['url'] for v in m['versions'] if v['id']=='$VERSION'))" \
    | xargs curl -s \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['downloads']['server']['url'])")
  curl -s -o server.jar "$URL"
fi

[ -f eula.txt ] || echo 'eula=true' > eula.txt
[ -f server.properties ] || cat > server.properties <<EOF
online-mode=false
level-type=minecraft\:flat
level-seed=botfleet
generate-structures=false
view-distance=6
spawn-protection=0
sync-chunk-writes=false
motd=botfleet e2e
max-players=8
EOF

echo "starting server (heap $HEAP)…"
exec java -Xms512M -Xmx"$HEAP" -jar server.jar nogui
