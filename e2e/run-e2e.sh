#!/bin/bash
# run-e2e.sh — Longtable Android e2e gate (runs on the build host).
# Usage: run-e2e.sh [apk-path]
#   1. boots the longtable-test emulator (idempotent)
#   2. starts the Appium server if needed (tmux session longtable-appium)
#   3. starts the HTTPS URL-import fixture if needed (tmux lt-fixture-https)
#   4. runs the webdriverio suite against the APK
# Exit 0 = all steps passed; non-zero = at least one step failed (see per-step report).
set -u

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$SELF_DIR/.." && pwd)
ROOT=${LT_ROOT:-$(cd "$REPO/../.." && pwd)}
EMU=${LT_EMU:-$ROOT/tools/android-emu/emu.sh}
E2E_DIR=$REPO/e2e
APK="${1:-${LT_APK:-$ROOT/builds/longtable/longtable-debug.apk}}"
FIXTURE_CERTS=${LT_FIXTURE_CERTS:-$ROOT/tools/android-emu/fixture-certs}
export ANDROID_HOME=$ROOT/tools/android-sdk
export ANDROID_SDK_ROOT=$ANDROID_HOME
export JAVA_HOME=$ROOT/tools/jdk-21
FIXTURE_PORT=18443

[ -f "$APK" ] || { echo "ERROR: APK not found: $APK" >&2; exit 2; }

"$EMU" boot || { echo "ERROR: emulator failed to boot" >&2; exit 2; }

if ! curl -sf --max-time 3 http://127.0.0.1:4723/status > /dev/null 2>&1; then
  echo "starting appium server (tmux longtable-appium)"
  tmux kill-session -t longtable-appium 2>/dev/null || true
  # tmux drops our env; appium needs ANDROID_HOME/JAVA_HOME to drive adb.
  # Appium 3.x gates the chromedriver download (needed for WEBVIEW contexts)
  # behind the 'uiautomator2:chromedriver_autodownload' insecure feature;
  # without it, webview automation fails with "No Chromedriver found".
  tmux new -s longtable-appium -d "env ANDROID_HOME=$ANDROID_HOME ANDROID_SDK_ROOT=$ANDROID_SDK_ROOT JAVA_HOME=$JAVA_HOME PATH=/usr/local/bin:/usr/bin:/bin appium server --address 127.0.0.1 --port 4723 --allow-insecure uiautomator2:chromedriver_autodownload"
  ok=0
  for i in $(seq 1 30); do
    sleep 2
    if curl -sf --max-time 3 http://127.0.0.1:4723/status > /dev/null 2>&1; then ok=1; break; fi
  done
  [ "$ok" = 1 ] || { echo "ERROR: appium server did not start" >&2; exit 2; }
fi

# HTTPS fixture for the url-import positive test (recipe.html over TLS with
# CORS). The emulator trusts FIXTURE_CERTS/ca.crt via its user store, and the
# debug APK's networkSecurityConfig (src/debug, debug-only) trusts user CAs.
[ -f "$FIXTURE_CERTS/server.crt" ] || { echo "ERROR: fixture certs missing: $FIXTURE_CERTS (see e2e/README.md)" >&2; exit 2; }
if ! curl -sk --max-time 3 -o /dev/null -w "%{http_code}" "https://127.0.0.1:$FIXTURE_PORT/recipe.html" 2>/dev/null | grep -q 200; then
  echo "starting https fixture (tmux lt-fixture-https, port $FIXTURE_PORT)"
  tmux kill-session -t lt-fixture-https 2>/dev/null || true
  tmux new -s lt-fixture-https -d "python3 $E2E_DIR/fixtures/serve-https.py $FIXTURE_CERTS $FIXTURE_PORT"
  ok=0
  for i in $(seq 1 15); do
    sleep 1
    if curl -sk --max-time 3 -o /dev/null "https://127.0.0.1:$FIXTURE_PORT/recipe.html" 2>/dev/null; then ok=1; break; fi
  done
  [ "$ok" = 1 ] || { echo "ERROR: https fixture did not start" >&2; exit 2; }
fi

cd "$E2E_DIR"
if [ ! -d node_modules ]; then
  echo "installing e2e dependencies (first run)"
  npm ci || { echo "ERROR: npm ci failed" >&2; exit 2; }
fi

APK="$APK" node test.mjs
