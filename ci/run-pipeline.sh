#!/bin/bash
# run-pipeline.sh — Longtable on-box CI pipeline. See ci/README.md.
#
# Triggered by longtable-ci.service (longtable-ci.path watches
# .git/refs/heads/main; longtable-ci.timer is a 10-minute fallback).
# Installed to /home/devbox/ops/longtable-ci/run-pipeline.sh by
# ci/install-ci.sh; the copy in the repo is the source of truth.
#
# Builds the committed tree in a pristine git worktree so a dirty
# developer checkout never leaks into a build. Publishes the APK only
# when EVERY stage passes. Serialized with flock: the emulator is a
# shared resource and must never see two pipelines at once.

set -uo pipefail

REPO=/home/devbox/code/longtable
STATE=/home/devbox/ops/longtable-ci
LOGS=$STATE/logs
WT=$STATE/work/wt
PUBLISH_APK=/home/devbox/builds/longtable/longtable-debug.apk
LOCK_FILE=$STATE/pipeline.lock
APK_REL=android/app/build/outputs/apk/debug/app-debug.apk

export PATH=/usr/local/bin:/usr/bin:/bin
export HOME=/home/crudobi
export JAVA_HOME=/home/devbox/tools/jdk-21
export ANDROID_HOME=/home/devbox/tools/android-sdk
export ANDROID_SDK_ROOT=/home/devbox/tools/android-sdk

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
do_unit()      { (cd "$WT" && npm test); }
do_build()     { (cd "$WT" && npm run build); }
do_capsync()   { (cd "$WT" && npx cap sync android); }
do_apk()       { (cd "$WT/android" && ./gradlew assembleDebug --console=plain); }
# The e2e harness is box infrastructure and runs from the repo checkout
# (run-e2e.sh hardcodes its paths); the artifact under test is the
# worktree-built APK.
do_e2e()       { "$REPO/e2e/run-e2e.sh" "$WT/$APK_REL"; }
do_migration() { (cd "$REPO/e2e" && APK="$WT/$APK_REL" node proof-migration.mjs); }
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
  STAGE_RESULTS=""; FAILED_STAGE=""; APK_MD5=""
  local t0=$SECONDS
  say "run $run_id commit $TARGET_HASH"
  {
    say "run $run_id commit $TARGET_HASH (full log: $log)"
    stage checkout        do_checkout  &&
    stage npm-ci          do_npm_ci    &&
    stage typecheck       do_typecheck &&
    stage unit-tests      do_unit      &&
    stage web-build       do_build     &&
    stage cap-sync        do_capsync   &&
    stage apk             do_apk       &&
    stage e2e-gate        do_e2e       &&
    stage migration-proof do_migration &&
    stage publish         do_publish
    true
  } >>"$log" 2>&1
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
