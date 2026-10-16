#!/bin/bash
# run-pipeline.sh — Longtable on-box CI pipeline. See ci/README.md.
#
# Triggered by longtable-ci.service (longtable-ci.path watches
# .git/refs/heads/main; longtable-ci.timer is a 10-minute fallback).
# Installed into the ops CI state dir by ci/install-ci.sh; the copy in
# the repo is the source of truth.
#
# Builds the committed tree in a pristine git worktree so a dirty
# developer checkout never leaks into a build. Publishes the APK only
# when EVERY stage passes. Serialized with flock: the emulator is a
# shared resource and must never see two pipelines at once.
#
# Two APK builds (H1): the web-build/apk stages build with
# VITE_LT_DEBUG_HOOKS=1 — the emulator proofs drive the app through
# window.__ltFriends/__ltPublic. After every proof passes, the
# release-build stage rebuilds the web bundle WITHOUT the flag, asserts
# the hook strings are absent from the bundle, re-syncs and rebuilds
# the APK — and THAT artifact is what publish ships.

set -uo pipefail

# --- locations ---------------------------------------------------------------
# LT_ROOT is the host dir that parents code/, ops/, builds/ and tools/.
# Override with LT_ROOT; otherwise derive it from this script's location:
# the script runs either from the repo checkout (ci/, two levels under
# code/) or installed into the ops state dir (ops/longtable-ci/).
SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ -n "${LT_ROOT:-}" ]; then
  ROOT=$LT_ROOT
elif [ -f "$SELF_DIR/../package.json" ]; then
  ROOT=$(cd "$SELF_DIR/../../.." && pwd)
else
  ROOT=$(cd "$SELF_DIR/../.." && pwd)
fi
REPO=${LT_REPO:-$ROOT/code/longtable}
STATE=${LT_CI_STATE:-$ROOT/ops/longtable-ci}
LOGS=$STATE/logs
WT=$STATE/work/wt
PUBLISH_APK=${LT_PUBLISH_APK:-$ROOT/builds/longtable/longtable-debug.apk}
LOCK_FILE=$STATE/pipeline.lock
APK_REL=android/app/build/outputs/apk/debug/app-debug.apk

export PATH=/usr/local/bin:/usr/bin:/bin
export HOME="${HOME:-/home/$(id -un)}"
export JAVA_HOME=${LT_JAVA_HOME:-$ROOT/tools/jdk-21}
export ANDROID_HOME=${LT_ANDROID_HOME:-$ROOT/tools/android-sdk}
export ANDROID_SDK_ROOT=$ANDROID_HOME

# Optional operator environment (e.g. LT_HOST_LAN_IP — this host's LAN
# address, used as the fleet TURN relay address). Lives in the ops state
# dir, never in the repo; the systemd unit also loads it (EnvironmentFile).
if [ -f "$STATE/ci.env" ]; then set -a; . "$STATE/ci.env"; set +a; fi

mkdir -p "$LOGS" "$STATE/work"

say() { echo "[ci] $*"; }

# --- serialization ---------------------------------------------------------
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  say "another pipeline run holds the lock; exiting (it re-checks HEAD)"
  exit 0
fi

# --- stage bookkeeping ------------------------------------------------------
STAGE_RESULTS=""   # "name:ok:seconds,name:fail:seconds,..."
FAILED_STAGE=""
FLEET_UP=""        # set once fleet provisioning is attempted
APK_MD5=""

stage() {
  local name=$1; shift
  local t0=$SECONDS rc
  say "=== stage: $name"
  if "$@"; then
    STAGE_RESULTS="$STAGE_RESULTS$name:ok:$((SECONDS-t0)),"
    say "--- stage $name OK ($((SECONDS-t0))s)"
    return 0
  else
    rc=$?
    STAGE_RESULTS="$STAGE_RESULTS$name:fail:$((SECONDS-t0)),"
    FAILED_STAGE=$name
    say "--- stage $name FAILED rc=$rc ($((SECONDS-t0))s)"
    return 1
  fi
}

# --- stage implementations --------------------------------------------------
TARGET_HASH=""

do_checkout() {
  git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || true
  rm -rf "$WT"
  git -C "$REPO" worktree prune
  git -C "$REPO" worktree add --detach "$WT" "$TARGET_HASH"
}
do_npm_ci()    { (cd "$WT" && npm ci --no-audit --no-fund); }
do_typecheck() { (cd "$WT" && npm run typecheck); }
do_lint()      { (cd "$WT" && npm run lint); }
do_unit()      { (cd "$WT" && npm test); }
# Proof build: debug hooks ON (VITE_LT_DEBUG_HOOKS=1). The assertion
# pins the wiring: if the hooks ever vanish from the proof bundle, the
# proofs would fail obscurely — fail here, loudly, instead.
do_build()     {
  local turn_pw=""
  if [ -f "$STATE/dev-turn-password" ]; then turn_pw=$(cat "$STATE/dev-turn-password"); fi
  (cd "$WT" && VITE_LT_DEBUG_HOOKS=1 VITE_LT_DEV_TURN_PASSWORD="$turn_pw" npm run build) &&
  grep -rq '__ltFriends' "$WT/dist/assets" &&
  grep -rq '__ltPublic' "$WT/dist/assets"
}
# Release build: same tree, hooks OFF and no dev TURN password
# injected, rebuilt after all proofs pass; its APK is the one
# do_publish ships. Fails closed if a hook string or any dev TURN
# credential (the burned one, or the rotated one) survives in the
# bundle.
do_release_build() {
  (cd "$WT" && env -u VITE_LT_DEBUG_HOOKS -u VITE_LT_DEV_TURN_PASSWORD npm run build) &&
  ! grep -rq '__ltFriends' "$WT/dist/assets" &&
  ! grep -rq '__ltPublic' "$WT/dist/assets" &&
  ! grep -rqF 'dev-turn-password' "$WT/dist/assets" &&
  release_turn_clean &&
  (cd "$WT" && npx cap sync android) &&
  (cd "$WT/android" && ./gradlew assembleDebug --console=plain)
}
# The rotated dev TURN password must not ship either. The pattern is
# read from the ops password file (grep -f), so the value itself never
# appears on a command line or in a log.
release_turn_clean() {
  if [ -s "$STATE/dev-turn-password" ]; then
    ! grep -rqF -f "$STATE/dev-turn-password" "$WT/dist/assets"
  fi
}
# The AppView is a standalone subpackage (own package.json + lockfile);
# its unit tests cover ingest filtering, verify-then-index and FTS5
# search. Runs in the pristine worktree like every other stage.
do_appview()   { (cd "$WT/appview" && npm ci --no-audit --no-fund && npm test); }
do_capsync()   { (cd "$WT" && npx cap sync android); }
do_apk()       { (cd "$WT/android" && ./gradlew assembleDebug --console=plain); }
# The e2e harness is box infrastructure and runs from the repo checkout
# (it derives its paths from its own location); the artifact under test
# is the worktree-built APK.
do_e2e()       { "$REPO/e2e/run-e2e.sh" "$WT/$APK_REL"; }
do_migration() { (cd "$REPO/e2e" && APK="$WT/$APK_REL" node proof-migration.mjs); }
# The fleet suite (e2e/run-fleet.sh) is driven stage-by-stage so
# status.json keeps per-proof granularity. The pipeline already holds
# pipeline.lock, so the orchestrator runs with LT_FLEET_NO_LOCK=1 (its
# own flock would deadlock against ours). FLEET_UP is set BEFORE the
# provision call so the post-chain teardown runs even when provisioning
# fails halfway with emulators already booted.
do_fleet_provision() {
  FLEET_UP=1
  APK="$WT/$APK_REL" LT_FLEET_NO_LOCK=1 "$REPO/e2e/run-fleet.sh" provision
}
do_proof() { # proof-name
  APK="$WT/$APK_REL" LT_FLEET_NO_LOCK=1 "$REPO/e2e/run-fleet.sh" run "$1"
}
do_fleet_teardown() {
  LT_FLEET_NO_LOCK=1 "$REPO/e2e/run-fleet.sh" teardown
}

do_publish() {
  cp "$WT/$APK_REL" "$PUBLISH_APK.tmp"
  mv "$PUBLISH_APK.tmp" "$PUBLISH_APK"
  APK_MD5=$(md5sum "$PUBLISH_APK" | cut -d' ' -f1)
  say "published $PUBLISH_APK md5=$APK_MD5"
}

write_status() {
  CI_STAGES="$STAGE_RESULTS" CI_COMMIT="$TARGET_HASH" \
  CI_RESULT="$1" CI_FAILED_STAGE="$FAILED_STAGE" \
  CI_STARTED_AT="$2" CI_FINISHED_AT="$3" CI_DURATION_S="$4" \
  CI_APK_MD5="$APK_MD5" CI_LOG="$5" \
  python3 - "$STATE/status.json" "$STATE/history.jsonl" <<'PYEOF'
import json, os, sys
status_path, history_path = sys.argv[1], sys.argv[2]
stages = []
raw = os.environ.get("CI_STAGES", "").strip(",")
if raw:
    for entry in raw.split(","):
        name, ok, secs = entry.rsplit(":", 2)
        stages.append({"name": name, "ok": ok == "ok", "seconds": int(secs)})
rec = {
    "commit": os.environ.get("CI_COMMIT", ""),
    "result": os.environ.get("CI_RESULT", ""),
    "failed_stage": os.environ.get("CI_FAILED_STAGE", "") or None,
    "started_at": os.environ.get("CI_STARTED_AT", ""),
    "finished_at": os.environ.get("CI_FINISHED_AT", ""),
    "duration_s": int(os.environ.get("CI_DURATION_S", "0")),
    "published": os.environ.get("CI_RESULT", "") == "success",
    "apk_md5": os.environ.get("CI_APK_MD5", "") or None,
    "log": os.environ.get("CI_LOG", ""),
    "stages": stages,
}
with open(status_path, "w") as f:
    json.dump(rec, f, indent=2)
    f.write("\n")
with open(history_path, "a") as f:
    f.write(json.dumps(rec) + "\n")
PYEOF
}

run_one() {
  TARGET_HASH=$1
  local short run_id log started finished result
  short=$(git -C "$REPO" rev-parse --short "$TARGET_HASH")
  run_id="$(date +%Y%m%d-%H%M%S)-$short"
  log="$LOGS/$run_id.log"
  started=$(date -Iseconds)
  STAGE_RESULTS=""; FAILED_STAGE=""; APK_MD5=""; FLEET_UP=""
  local t0=$SECONDS
  say "run $run_id commit $TARGET_HASH"
  {
    say "run $run_id commit $TARGET_HASH (full log: $log)"
    stage checkout        do_checkout  &&
    stage npm-ci          do_npm_ci    &&
    stage typecheck       do_typecheck &&
    stage lint            do_lint      &&
    stage unit-tests      do_unit      &&
    stage appview-tests   do_appview   &&
    stage web-build       do_build     &&
    stage cap-sync        do_capsync   &&
    stage apk             do_apk       &&
    stage fleet-provision do_fleet_provision &&
    stage e2e-gate        do_e2e       &&
    stage migration-proof do_migration &&
    stage proof-p2p       do_proof proof-p2p &&
    stage proof-friends   do_proof proof-friends &&
    stage proof-public    do_proof proof-public &&
    stage proof-thirdparty do_proof proof-thirdparty &&
    stage proof-importer  do_proof proof-importer &&
    stage proof-localapi  do_proof proof-localapi &&
    stage proof-hubfail   do_proof proof-hubfail &&
    stage release-build   do_release_build &&
    stage publish         do_publish
    true
  } >>"$log" 2>&1
  if [ -n "$FLEET_UP" ]; then
    {
      say "=== stage: fleet-teardown (post-chain; runs pass or fail)"
      tt0=$SECONDS
      if do_fleet_teardown; then
        STAGE_RESULTS="${STAGE_RESULTS}fleet-teardown:ok:$((SECONDS-tt0)),"
        say "--- stage fleet-teardown OK ($((SECONDS-tt0))s)"
      else
        STAGE_RESULTS="${STAGE_RESULTS}fleet-teardown:fail:$((SECONDS-tt0)),"
        say "--- stage fleet-teardown FAILED ($((SECONDS-tt0))s) — emulators may still be running; investigate"
      fi
    } >>"$log" 2>&1
  fi
  finished=$(date -Iseconds)
  if [ -n "$FAILED_STAGE" ]; then result=failed; else result=success; fi
  write_status "$result" "$started" "$finished" "$((SECONDS-t0))" "$log"
  say "run $run_id result=$result failed_stage=${FAILED_STAGE:-none} duration=$((SECONDS-t0))s log=$log"
  if [ "$result" = success ]; then
    git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"
  else
    say "failed worktree kept for inspection at $WT (wiped by next run)"
  fi
}

# --- main loop: process HEAD, then catch up if it moved during the run -----
while :; do
  TARGET=$(git -C "$REPO" rev-parse main)
  DONE=$(cat "$STATE/last-processed" 2>/dev/null || echo "")
  if [ "$TARGET" = "$DONE" ]; then
    say "main @ $TARGET already processed; nothing to do"
    break
  fi
  run_one "$TARGET"
  echo "$TARGET" > "$STATE/last-processed"
done
