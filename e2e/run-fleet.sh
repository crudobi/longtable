#!/bin/bash
# run-fleet.sh — Longtable multi-emulator fleet test orchestrator.
#
# One entrypoint that takes the fleet from bare state to a full
# multi-device validation and back down again:
#
#   lock -> provision + boot all 3 AVDs (emu.sh/fleet.sh, idempotent,
#           includes fixture-CA trust) -> ensure support services
#           (Appium, HTTPS fixture, signaling, TURN, ATProto testnet
#           + seed, AppView, TLS proxies) -> install the APK under test
#           -> run the suite in a safe order with an app-data reset
#           before each stateful proof -> per-proof summary -> teardown
#           (all emulators stopped; shared services left running).
#
# Usage:
#   run-fleet.sh                 full suite (as above)
#   run-fleet.sh provision       provision + services + install APK only
#   run-fleet.sh run <proof>     reset + run one proof (fleet must be up;
#                                services are re-ensured cheaply)
#   run-fleet.sh teardown        stop all fleet emulators
#
# Suite order (it matters — see e2e/README.md "Fleet suite"):
#   e2e-gate, migration-proof, proof-p2p, proof-friends, proof-public,
#   proof-thirdparty, proof-importer, proof-localapi, proof-hubfail
#   (proof-thirdparty consumes proof-public's seeded accounts + mimic
#    record; proof-hubfail runs last because it rewrites the devices'
#    hub configuration.)
#
# Env:
#   APK                APK under test (default:
#                      /home/devbox/builds/longtable/longtable-debug.apk).
#                      CI passes the pristine-worktree build here.
#   LT_FLEET_NO_LOCK=1 the caller already holds the pipeline flock
#                      (CI stages). Standalone runs take
#                      /home/devbox/ops/longtable-ci/pipeline.lock —
#                      the same lock the CI pipeline uses — so a manual
#                      run and a pipeline run can never collide on the
#                      shared emulators/Appium.
#   LT_FLEET_KEEP_UP=1 full-suite mode: skip the teardown at the end.
#   FLEET_LOG_DIR      where per-step logs + summary.txt go
#                      (default /home/devbox/ops/longtable-ci/fleet-logs/<ts>)
#
# Teardown policy: ONLY the emulators are stopped. Appium, signaling,
# TURN, the testnet, the AppView, the TLS proxies, the HTTPS fixture and
# proof-hubfail's packaged hubs are shared box services with negligible
# idle cost; the emulators are the multi-GB RAM cost and the thing that
# must never idle forever. (In CI, teardown runs after the stage chain
# whether the chain passed or failed, and its result is recorded as a
# fleet-teardown entry in status.json; it does not retroactively block
# a publish that already passed every test stage — see run-pipeline.sh.)
#
# Failure honesty: any provisioning error (including a fixture-CA
# verify failure) or proof failure fails the run, names the step, and
# keeps its log. Nothing is ever skipped silently.
#
# Retry policy: emulator proofs are subject to infrastructure
# transients (emulator networking stalls, WebView/Appium hiccups) that
# manual sweeps always handled by re-running before believing a red.
# Each proof therefore gets up to LT_FLEET_PROOF_ATTEMPTS attempts
# (default 2): a failed attempt is followed by a guest reboot of the
# involved emulators and a full state reset. Assertions are never
# touched — a proof must pass in full on some attempt or the run
# fails. Attempts are bannered in the proof's log and a pass on a
# later attempt is noted in the summary.

set -uo pipefail

REPO=/home/devbox/code/longtable
E2E_DIR=$REPO/e2e
EMU_DIR=/home/devbox/tools/android-emu
FLEET=$EMU_DIR/fleet.sh
FIXTURE_CERTS=$EMU_DIR/fixture-certs
TESTNET_DIR=$REPO/services/atproto-testnet
APPVIEW_DIR=$REPO/appview
ACCOUNTS_FILE=/home/devbox/ops/longtable-atproto/accounts.json
LOCK_FILE=/home/devbox/ops/longtable-ci/pipeline.lock
PKG=kitchen.longtable.app
APK="${APK:-/home/devbox/builds/longtable/longtable-debug.apk}"
ADB=/home/devbox/tools/android-sdk/platform-tools/adb

# Absolute path to this script, for self-invocation of the internal
# __services/__install-apk/__probe-all subcommands. $0 alone is not
# enough: when the script is started by a relative path (e.g.
# `e2e/run-fleet.sh provision` from the repo root) and the main flow
# later cd's into $E2E_DIR, a relative $0 no longer resolves and the
# provision phase dies with "failed to run command 'e2e/run-fleet.sh'".
SELF=$(readlink -f "$0")

export PATH=/usr/local/bin:/usr/bin:/bin
export HOME="${HOME:-/home/crudobi}"
export JAVA_HOME=/home/devbox/tools/jdk-21
export ANDROID_HOME=/home/devbox/tools/android-sdk
export ANDROID_SDK_ROOT=/home/devbox/tools/android-sdk
export APK

TS=$(date +%Y%m%d-%H%M%S)
LOGDIR="${FLEET_LOG_DIR:-/home/devbox/ops/longtable-ci/fleet-logs/$TS}"
mkdir -p "$LOGDIR"

say() { echo "[fleet-run] $*"; }
RESULTS=""
FAILED=""
NOTES=""

note_for() { # proof-name -> "attempt N" if it passed on a later attempt
  local x
  for x in $NOTES; do case "$x" in "$1":*) echo "${x#*:}" | tr '-' ' ' ;; esac; done
}

record() { # name ok seconds
  if [ "$2" = "ok" ]; then RESULTS="$RESULTS$1:ok:$3,"; else RESULTS="$RESULTS$1:fail:$3,"; FAILED="$FAILED $1"; fi
}

run_step() { # name timeout_s cmd...
  local name=$1 tmo=$2; shift 2
  local t0=$SECONDS rc
  say "=== step: $name (timeout ${tmo}s)"
  timeout --kill-after=30s "${tmo}s" "$@" 2>&1 | tee "$LOGDIR/$name.log"
  rc=${PIPESTATUS[0]}
  if [ "$rc" = "0" ]; then
    record "$name" ok $((SECONDS-t0)); say "--- step $name OK ($((SECONDS-t0))s)"
    return 0
  fi
  record "$name" fail $((SECONDS-t0))
  say "--- step $name FAILED rc=$rc ($((SECONDS-t0))s) — log: $LOGDIR/$name.log"
  return 1
}

# --- locking ---------------------------------------------------------------
take_lock() {
  if [ "${LT_FLEET_NO_LOCK:-}" = "1" ]; then
    say "lock: held by caller (LT_FLEET_NO_LOCK=1)"
    return 0
  fi
  exec 9>"$LOCK_FILE"
  say "lock: acquiring $LOCK_FILE (same flock as the CI pipeline)..."
  if ! flock -w 14400 9; then
    say "ERROR: could not acquire the pipeline lock within 4h" >&2
    return 1
  fi
  say "lock: acquired"
}

# --- support services --------------------------------------------------------
# NOTE: no `grep -q` on these pipes. With pipefail, grep -q exiting on
# first match SIGPIPEs ss (exit 141) and the pipeline reports failure
# despite the match — on this box the UDP table is huge and :3478 has
# ~50 sockets, so udp_listening read as permanently down and every
# ensure_turn burned its full wait loop (seen 2026-10-13). Plain grep
# reads to EOF; its exit code is the verdict.
port_listening() { ss -ltn 2>/dev/null | grep ":$1 " > /dev/null; }
udp_listening()  { ss -lun 2>/dev/null | grep ":$1 " > /dev/null; }

tmux_fresh() { # session, command-string — kill any stale session first.
  # A leftover session whose process died (e.g. a pane whose command was
  # piped through `head` and got SIGPIPEd) must never be mistaken for a
  # running service: callers probe the PORT, and on failure recreate.
  tmux kill-session -t "$1" 2>/dev/null || true
  tmux new -s "$1" -d "$2"
}

wait_http() { # url, tries — curl -sf until success
  local url=$1 tries=${2:-30} i
  for i in $(seq 1 "$tries"); do
    if curl -sf --max-time 3 "$url" > /dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}
wait_https_k() { # url, tries — same, self-signed fixture cert
  local url=$1 tries=${2:-30} i
  for i in $(seq 1 "$tries"); do
    if curl -skf --max-time 3 "$url" > /dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

ensure_appium() {
  if curl -sf --max-time 3 http://127.0.0.1:4723/status > /dev/null 2>&1; then
    say "appium: already up"
    return 0
  fi
  say "appium: starting (tmux longtable-appium)"
  tmux kill-session -t longtable-appium 2>/dev/null || true
  tmux new -s longtable-appium -d 'env ANDROID_HOME=/home/devbox/tools/android-sdk ANDROID_SDK_ROOT=/home/devbox/tools/android-sdk JAVA_HOME=/home/devbox/tools/jdk-21 PATH=/usr/local/bin:/usr/bin:/bin appium server --address 127.0.0.1 --port 4723 --allow-insecure uiautomator2:chromedriver_autodownload'
  wait_http http://127.0.0.1:4723/status 30 || { say "ERROR: appium did not start" >&2; return 1; }
}

ensure_fixture() {
  [ -f "$FIXTURE_CERTS/server.crt" ] || { say "ERROR: fixture certs missing: $FIXTURE_CERTS" >&2; return 1; }
  if curl -sk --max-time 3 -o /dev/null -w "%{http_code}" "https://127.0.0.1:18443/recipe.html" 2>/dev/null | grep -q 200; then
    say "https fixture: already up"
    return 0
  fi
  say "https fixture: starting (tmux lt-fixture-https)"
  tmux kill-session -t lt-fixture-https 2>/dev/null || true
  tmux new -s lt-fixture-https -d "python3 $E2E_DIR/fixtures/serve-https.py $FIXTURE_CERTS 18443"
  wait_https_k https://127.0.0.1:18443/recipe.html 15 || { say "ERROR: https fixture did not start" >&2; return 1; }
}

ensure_signaling() {
  if port_listening 4444; then say "signaling: already up"; return 0; fi
  say "signaling: starting (tmux lt-signaling)"
  tmux_fresh lt-signaling 'node /home/devbox/code/longtable/signaling/server.mjs'
  local i
  for i in $(seq 1 15); do port_listening 4444 && return 0; sleep 2; done
  say "ERROR: signaling did not start" >&2; return 1
}

ensure_turn() {
  if udp_listening 3478; then say "turn: already up"; return 0; fi
  say "turn: starting (tmux lt-turn)"
  if [ ! -f /tmp/turnserver.conf ]; then
    # The local test-rig TURN config (test credential for the LAN rig
    # only; packaged hubs generate their own). Recreate it if /tmp was
    # cleared by a reboot.
    cat > /tmp/turnserver.conf <<'EOF'
listening-port=3478
listening-ip=0.0.0.0
relay-ip=192.0.2.10
external-ip=192.0.2.10
realm=longtable
user=longtable:dev-turn-password
lt-cred-mech
no-stdout-log
log-file=/tmp/turnserver.log
EOF
  fi
  # --pidfile under /tmp matches the original long-running invocation;
  # without it coturn defaults to /var/run/turnserver.pid, hits a
  # permission error, and is slow to bind.
  tmux_fresh lt-turn 'turnserver -c /tmp/turnserver.conf --pidfile=/tmp/turnserver.pid'
  local i
  for i in $(seq 1 30); do udp_listening 3478 && return 0; sleep 2; done
  say "ERROR: turnserver did not start" >&2; return 1
}

TESTNET_STARTED=0
ensure_testnet() {
  if curl -sf --max-time 3 http://localhost:2583/xrpc/com.atproto.server.describeServer > /dev/null 2>&1; then
    say "testnet: already up"
  else
    say "testnet: starting (tmux lt-atproto)"
    tmux kill-session -t lt-atproto 2>/dev/null || true
    tmux new -s lt-atproto -d "cd $TESTNET_DIR && node start.mjs"
    if ! wait_http http://localhost:2583/xrpc/com.atproto.server.describeServer 60; then
      say "ERROR: testnet PDS did not come up" >&2; return 1
    fi
    TESTNET_STARTED=1
  fi
  # Seed (idempotent within a testnet lifetime; mandatory after a
  # restart because the PLC is in-memory and DIDs are re-minted).
  say "testnet: seeding proof accounts"
  (cd "$TESTNET_DIR" && npm run seed --silent) || { say "ERROR: testnet seed failed" >&2; return 1; }
  [ -f "$ACCOUNTS_FILE" ] || { say "ERROR: seed did not write $ACCOUNTS_FILE" >&2; return 1; }
  # TLS proxy in front of the PDS (emulator reaches it at 10.0.2.2:2584).
  if curl -skf --max-time 3 https://127.0.0.1:2584/xrpc/com.atproto.server.describeServer > /dev/null 2>&1; then
    say "tls-pds proxy: already up"
  else
    say "tls-pds proxy: starting (tmux lt-tls-pds)"
    tmux kill-session -t lt-tls-pds 2>/dev/null || true
    tmux new -s lt-tls-pds -d "node $TESTNET_DIR/tls-proxy.mjs 2584 http://localhost:2583"
    wait_https_k https://127.0.0.1:2584/xrpc/com.atproto.server.describeServer 20 \
      || { say "ERROR: tls-pds proxy did not start" >&2; return 1; }
  fi
}

ensure_appview() {
  if curl -sf --max-time 3 http://localhost:3210/health > /dev/null 2>&1; then
    if [ "$TESTNET_STARTED" = "1" ]; then
      say "appview: testnet was restarted — bouncing appview so ingest reconnects to the fresh PDS"
      tmux kill-session -t lt-appview 2>/dev/null || true
    else
      say "appview: already up"
    fi
  fi
  if ! curl -sf --max-time 3 http://localhost:3210/health > /dev/null 2>&1; then
    say "appview: starting (tmux lt-appview)"
    tmux new -s lt-appview -d "cd $APPVIEW_DIR && env APPVIEW_PORT=3210 APPVIEW_DB=/home/devbox/ops/longtable-appview/appview.db PDS_URL=http://localhost:2583 PLC_URL=http://localhost:2582 node index.mjs"
    wait_http http://localhost:3210/health 30 || { say "ERROR: appview did not start" >&2; return 1; }
  fi
  if curl -skf --max-time 3 https://127.0.0.1:3211/health > /dev/null 2>&1; then
    say "tls-appview proxy: already up"
  else
    say "tls-appview proxy: starting (tmux lt-tls-appview)"
    tmux kill-session -t lt-tls-appview 2>/dev/null || true
    tmux new -s lt-tls-appview -d "node $TESTNET_DIR/tls-proxy.mjs 3211 http://localhost:3210"
    wait_https_k https://127.0.0.1:3211/health 20 || { say "ERROR: tls-appview proxy did not start" >&2; return 1; }
  fi
}

ensure_services() {
  ensure_appium    || return 1
  ensure_fixture   || return 1
  ensure_signaling || return 1
  ensure_turn      || return 1
  ensure_testnet   || return 1
  ensure_appview   || return 1
  if [ ! -d "$E2E_DIR/node_modules" ]; then
    say "installing e2e dependencies (first run)"
    (cd "$E2E_DIR" && npm ci --no-audit --no-fund) || return 1
  fi
}

# --- phases ------------------------------------------------------------------

install_apk_all() {
  [ -f "$APK" ] || { say "ERROR: APK not found: $APK" >&2; return 1; }
  local s
  for s in emulator-5554 emulator-5556 emulator-5558; do
    say "installing $APK on $s"
    "$ADB" -s "$s" install -r -g "$APK" > /dev/null || { say "ERROR: install failed on $s" >&2; return 1; }
  done
}

# Functional per-device network verification (WebSocket + HTTPS + ICE inside
# the app WebView; see e2e/probe-net.mjs). A device that fails this would
# fail every network proof downstream with far less clear logs. Each
# device is probed up to 3 times with a settle pause: in the first
# minutes after an emulator boots, its WebView networking can stall
# transiently (connects hang, STUN unanswered) and then recover on its
# own — a permanently broken device (e.g. WiFi never associated) fails
# all three probes and fails the run, as it should.
probe_all() {
  local s attempt ok rc=0
  for s in emulator-5554 emulator-5556 emulator-5558; do
    ok=0
    for attempt in 1 2 3; do
      if ( cd "$REPO" && node e2e/probe-net.mjs "$s" ); then ok=1; break; fi
      say "net-verify: $s probe attempt $attempt failed — waiting 20s and re-probing"
      sleep 20
    done
    [ "$ok" = "1" ] || rc=1
  done
  return $rc
}

do_provision_phase() {
  run_step fleet-provision 1500 "$FLEET" provision --all || return 1
  run_step services 600 "$SELF" __services || return 1
  run_step install-apk 300 "$SELF" __install-apk || return 1
  run_step net-verify 900 "$SELF" __probe-all || return 1
}

# Serial sets per proof (app-data reset + install targets).
proof_serials() {
  case "$1" in
    proof-p2p)       echo "emulator-5554 emulator-5556" ;;
    proof-friends)   echo "emulator-5554 emulator-5556 emulator-5558" ;;
    proof-hubfail)   echo "emulator-5554 emulator-5556" ;;
    *)               echo "emulator-5554" ;;
  esac
}
proof_timeout() {
  case "$1" in
    proof-p2p)        echo 1500 ;;
    proof-friends)    echo 1800 ;;
    proof-public)     echo 1500 ;;
    proof-thirdparty) echo 1200 ;;
    proof-importer)   echo 900 ;;
    proof-localapi)   echo 1200 ;;
    proof-hubfail)    echo 1800 ;;
    *)                echo 900 ;;
  esac
}

reset_app() { # serials...
  local s
  for s in "$@"; do
    "$ADB" -s "$s" shell am force-stop "$PKG" > /dev/null 2>&1 || true
    "$ADB" -s "$s" shell pm clear "$PKG" > /dev/null 2>&1 || true
  done
}

PROOF_ATTEMPTS="${LT_FLEET_PROOF_ATTEMPTS:-2}"

reboot_serials() { # serials... — guest reboot (emulator process stays up)
  local s i
  for s in "$@"; do "$ADB" -s "$s" reboot > /dev/null 2>&1 || true; done
  for s in "$@"; do
    for i in $(seq 1 40); do
      [ "$("$ADB" -s "$s" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
      sleep 3
    done
  done
  sleep 10 # let radios/services settle after the reboot
}

do_run_proof() { # proof-name
  local p=$1 serials tmo s attempt t0 rc log overall_t0=$SECONDS
  serials=$(proof_serials "$p")
  tmo=$(proof_timeout "$p")
  [ -f "$E2E_DIR/$p.mjs" ] || { say "ERROR: unknown proof '$p' (no $E2E_DIR/$p.mjs)" >&2; return 1; }
  log="$LOGDIR/$p.log"
  : > "$log"
  for attempt in $(seq 1 "$PROOF_ATTEMPTS"); do
    say "=== step: $p (attempt $attempt/$PROOF_ATTEMPTS, timeout ${tmo}s)"
    say "resetting app data on: $serials"
    reset_app $serials
    # Belt-and-braces: make sure the APK under test is installed on the
    # reset targets (proofs that self-install simply redo this).
    for s in $serials; do
      "$ADB" -s "$s" install -r -g "$APK" > /dev/null || { say "ERROR: install failed on $s" >&2; record "$p" fail $((SECONDS-overall_t0)); return 1; }
    done
    echo "===== attempt $attempt/$PROOF_ATTEMPTS: $p =====" >> "$log"
    t0=$SECONDS
    timeout --kill-after=30s "${tmo}s" env APK="$APK" node "$E2E_DIR/$p.mjs" 2>&1 | tee -a "$log"
    rc=${PIPESTATUS[0]}
    if [ "$rc" = "0" ]; then
      record "$p" ok $((SECONDS-overall_t0))
      [ "$attempt" -gt 1 ] && NOTES="$NOTES $p:attempt-$attempt"
      say "--- step $p OK (attempt $attempt, $((SECONDS-overall_t0))s total)"
      return 0
    fi
    say "--- attempt $attempt of $p FAILED rc=$rc ($((SECONDS-t0))s)"
    if [ "$attempt" -lt "$PROOF_ATTEMPTS" ]; then
      say "rebooting ($serials) and resetting before retry"
      reboot_serials $serials
    fi
  done
  record "$p" fail $((SECONDS-overall_t0))
  say "--- step $p FAILED after $PROOF_ATTEMPTS attempts — log: $log"
  return 1
}

do_teardown() {
  "$FLEET" stop --all
}

print_summary() {
  {
    echo "=== fleet suite summary ($TS)"
    echo "APK under test: $APK"
    local raw entry name ok secs rest
    raw=$(echo "$RESULTS" | sed 's/,$//')
    IFS=',' read -ra entries <<< "$raw"
    for entry in "${entries[@]}"; do
      [ -n "$entry" ] || continue
      name=${entry%%:*}; rest=${entry#*:}; ok=${rest%%:*}; secs=${rest##*:}
      local note=""; note=$(note_for "$name")
      printf '%-18s %-4s %ss%s\n' "$name" "$ok" "$secs" "${note:+ ($note)}"
    done
    if [ -n "$FAILED" ]; then echo "FAILED:$FAILED"; else echo "ALL OK"; fi
  } | tee "$LOGDIR/summary.txt"
}

# --- modes -------------------------------------------------------------------

# Proofs resolve their fixtures/helpers relative to e2e/ (the same cwd
# the CI stages and manual runs have always used).
cd "$E2E_DIR"

MODE="${1:-all}"
case "$MODE" in
  __services)    ensure_services; exit $? ;;
  __install-apk) install_apk_all; exit $? ;;
  __probe-all)   probe_all; exit $? ;;
  all)
    take_lock || exit 1
    # If we die on a signal mid-suite, still stop the fleet.
    trap 'do_teardown > /dev/null 2>&1 || true' INT TERM
    overall=0
    do_provision_phase || overall=1
    if [ "$overall" = "0" ]; then
      run_step e2e-gate 900 "$E2E_DIR/run-e2e.sh" "$APK" || overall=1
    fi
    if [ "$overall" = "0" ]; then
      run_step migration-proof 600 env APK="$APK" node proof-migration.mjs || overall=1
    fi
    if [ "$overall" = "0" ]; then
      for p in proof-p2p proof-friends proof-public proof-thirdparty proof-importer proof-localapi proof-hubfail; do
        do_run_proof "$p" || { overall=1; break; }
      done
    fi
    if [ "${LT_FLEET_KEEP_UP:-}" != "1" ]; then
      t0=$SECONDS
      say "=== teardown: stopping fleet emulators (services stay up by policy)"
      if do_teardown; then record teardown ok $((SECONDS-t0)); else record teardown fail $((SECONDS-t0)); [ "$overall" = "0" ] && overall=1; fi
    else
      say "teardown skipped (LT_FLEET_KEEP_UP=1)"
    fi
    trap - INT TERM
    print_summary
    exit "$overall"
    ;;
  provision)
    take_lock || exit 1
    do_provision_phase
    exit $?
    ;;
  run)
    [ $# -ge 2 ] || { say "usage: run-fleet.sh run <proof-name>" >&2; exit 2; }
    take_lock || exit 1
    # Cheap services re-ensure: a service may have died (or been
    # restarted by an earlier proof) since the provision stage.
    ensure_services || exit 1
    do_run_proof "$2"
    exit $?
    ;;
  teardown)
    take_lock || exit 1
    do_teardown
    exit $?
    ;;
  *)
    say "usage: run-fleet.sh [all|provision|run <proof>|teardown]" >&2
    exit 2
    ;;
esac
