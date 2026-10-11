#!/bin/bash
# run-e2e.sh — Longtable Android e2e gate (runs on devbox).
# Usage: run-e2e.sh [apk-path]
#   1. boots the longtable-test emulator (idempotent)
#   2. starts the Appium server if needed (tmux session longtable-appium)
#   3. runs the webdriverio suite against the APK
# Exit 0 = all steps passed; non-zero = at least one step failed (see per-step report).
set -u

EMU=/home/devbox/tools/android-emu/emu.sh
E2E_DIR=/home/devbox/code/longtable/e2e
APK="${1:-/home/devbox/builds/longtable/longtable-debug.apk}"

[ -f "$APK" ] || { echo "ERROR: APK not found: $APK" >&2; exit 2; }

"$EMU" boot || { echo "ERROR: emulator failed to boot" >&2; exit 2; }

if ! curl -sf --max-time 3 http://127.0.0.1:4723/status > /dev/null 2>&1; then
  echo "starting appium server (tmux longtable-appium)"
  tmux kill-session -t longtable-appium 2>/dev/null || true
  # tmux drops our env; appium needs ANDROID_HOME/JAVA_HOME to drive adb.
  # Appium 3.x gates the chromedriver download (needed for WEBVIEW contexts)
  # behind the 'uiautomator2:chromedriver_autodownload' insecure feature;
  # without it, webview automation fails with "No Chromedriver found".
  tmux new -s longtable-appium -d 'env ANDROID_HOME=/home/devbox/tools/android-sdk ANDROID_SDK_ROOT=/home/devbox/tools/android-sdk JAVA_HOME=/home/devbox/tools/jdk-21 PATH=/usr/local/bin:/usr/bin:/bin appium server --address 127.0.0.1 --port 4723 --allow-insecure uiautomator2:chromedriver_autodownload'
  ok=0
  for i in $(seq 1 30); do
    sleep 2
    if curl -sf --max-time 3 http://127.0.0.1:4723/status > /dev/null 2>&1; then ok=1; break; fi
  done
  [ "$ok" = 1 ] || { echo "ERROR: appium server did not start" >&2; exit 2; }
fi

cd "$E2E_DIR"
if [ ! -d node_modules ]; then
  echo "installing e2e dependencies (first run)"
  npm ci || { echo "ERROR: npm ci failed" >&2; exit 2; }
fi

APK="$APK" node test.mjs
