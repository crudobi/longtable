#!/usr/bin/env bash
# pack-hub.sh — build the single-artifact Longtable hub tarball.
#
# Produces /home/devbox/builds/longtable/longtable-hub-<version>.tar.gz
# containing everything a stranger needs: the hub supervisor, the web
# app build, signaling, AppView, the managed-PDS testnet stack, and all
# node_modules — no npm install, no repo checkout at deploy time.
#
# Run from anywhere: bash hub/pack-hub.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

VERSION="$(node -p "require('./package.json').version")"
NAME="longtable-hub-$VERSION"
OUT_DIR="/home/devbox/builds/longtable"
mkdir -p "$OUT_DIR"

echo "[pack] building the web app (npm run build)…"
npm run build >/dev/null

STAGE_PARENT="$(mktemp -d)"
STAGE="$STAGE_PARENT/$NAME"
mkdir -p "$STAGE"

echo "[pack] staging $NAME…"
# Hub runtime files.
cp hub/hub.mjs hub/web-server.mjs hub/longtable-hub hub/hub.conf.example.json \
   hub/README.md hub/TELEMETRY.md hub/pack-hub.sh hub/stranger-test.sh "$STAGE/"
chmod +x "$STAGE/longtable-hub"
# The built web app.
cp -r dist "$STAGE/app"
# Services (each carries its own node_modules — fully self-contained).
cp -r signaling "$STAGE/signaling"
cp -r appview "$STAGE/appview"
mkdir -p "$STAGE/services"
cp -r services/atproto-testnet "$STAGE/services/atproto-testnet"
cp -r lexicons "$STAGE/lexicons"
echo "$VERSION" > "$STAGE/VERSION"
# Never ship dev state that may have accumulated in the service dirs.
rm -f "$STAGE/appview/"*.db "$STAGE/appview/"*.db-journal
rm -rf "$STAGE/appview/media" "$STAGE/appview/test"

echo "[pack] tarring…"
tar -czf "$OUT_DIR/$NAME.tar.gz" -C "$STAGE_PARENT" "$NAME"
rm -rf "$STAGE_PARENT"

ls -lh "$OUT_DIR/$NAME.tar.gz"
sha256sum "$OUT_DIR/$NAME.tar.gz"
echo "[pack] done: $OUT_DIR/$NAME.tar.gz"
