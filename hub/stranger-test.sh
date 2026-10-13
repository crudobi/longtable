#!/usr/bin/env bash
# stranger-test.sh — fresh hub deploy following ONLY hub/README.md.
#
# Simulates someone who did not write this software: unpack the tarball
# into a clean directory, copy the example config, make the documented
# edits (ports that are taken on this machine + a TURN password), start,
# verify, seed accounts, stop. Times the whole procedure; the Phase 4
# budget is under 10 minutes.
#
# usage: bash stranger-test.sh /path/to/longtable-hub-<version>.tar.gz
set -euo pipefail

TARBALL="${1:?usage: stranger-test.sh <tarball>}"
WORK="${2:-$(mktemp -d /tmp/lt-stranger-XXXXXX)}"
START=$(date +%s)

echo "[stranger] workdir: $WORK"
mkdir -p "$WORK"
tar -xzf "$TARBALL" -C "$WORK"
cd "$WORK"/longtable-hub-*/

# --- README: configure -------------------------------------------------
cp hub.conf.example.json hub.conf.json
# This machine already runs the dev services on the default ports, so per
# the README ("If a default port is already taken… change it here") move
# every port into a test block, and set a TURN password + SAN + host.
node -e '
  const fs = require("fs");
  const c = JSON.parse(fs.readFileSync("hub.conf.json", "utf8"));
  c.name = "stranger-hub";
  c.publicHost = "10.0.2.2";
  c.web.port = 18080;
  c.signaling.port = 14444;
  c.turn.port = 13478;
  c.turn.password = "stranger-test-password";
  c.appview.port = 13210;
  c.pds.plcPort = 12582;
  c.pds.pdsPort = 12583;
  c.tls.proxies = { appviewPort: 13211, pdsPort: 12584 };
  c.tls.san = "IP:10.0.2.2,DNS:localhost";
  fs.writeFileSync("hub.conf.json", JSON.stringify(c, null, 2));
'

# --- README: start ------------------------------------------------------
./longtable-hub start

# --- verify: poll the endpoints the README promises --------------------
ready=""
for i in $(seq 1 120); do
  if curl -sf http://localhost:18080/ >/dev/null 2>&1 \
     && curl -sf http://localhost:13210/health >/dev/null 2>&1 \
     && curl -sk https://127.0.0.1:13211/health >/dev/null 2>&1 \
     && curl -sf http://localhost:12583/ >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
if [ -z "$ready" ]; then
  echo "[stranger] FAIL: hub did not become ready" >&2
  ./longtable-hub status || true
  tail -30 data/hub.log || true
  ./longtable-hub stop || true
  exit 1
fi
echo "[stranger] hub endpoints ready after $(( $(date +%s) - START ))s"

./longtable-hub status

# --- README: seed accounts ----------------------------------------------
(cd services/atproto-testnet && \
  PDS_URL=http://localhost:12583 ACCOUNTS_FILE=../../data/accounts.json node seed.mjs >/dev/null)
test -s data/accounts.json
echo "[stranger] accounts seeded: $(node -p 'Object.keys(JSON.parse(require("fs").readFileSync("data/accounts.json","utf8"))).join(", ")')"

# --- README: stop ---------------------------------------------------------
./longtable-hub stop

ELAPSED=$(( $(date +%s) - START ))
echo "[stranger] total elapsed: ${ELAPSED}s (budget 600s)"
if [ "$ELAPSED" -ge 600 ]; then
  echo "[stranger] FAIL: over the 10-minute budget" >&2
  exit 1
fi
echo "[stranger] PASS"
