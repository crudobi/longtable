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
#
# Signed release (A4): after release-build, the signed-release stage
# builds bundleRelease + assembleRelease signed with the ops-dir
# upload keystore — but ONLY when HEAD carries an exact git tag. A3
# made release builds fail closed on untagged HEADs and CI builds
# every commit, so the stage gates on a tag and skips cleanly
# otherwise; the A3 check itself is never relaxed. Tag a commit
# (e.g. v0.1.0) to cut a signed release. Verified artifacts (apksigner
# + bundletool manifest + aapt2 badging) publish as
# longtable-release.aab/.apk (+ mapping.txt when produced) with
# .sha256 sidecars.

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
PUBLISH_AAB=${LT_PUBLISH_AAB:-$ROOT/builds/longtable/longtable-release.aab}
PUBLISH_RELEASE_APK=${LT_PUBLISH_RELEASE_APK:-$ROOT/builds/longtable/longtable-release.apk}
PUBLISH_MAPPING=${LT_PUBLISH_MAPPING:-$ROOT/builds/longtable/longtable-release-mapping.txt}
LOCK_FILE=$STATE/pipeline.lock
APK_REL=android/app/build/outputs/apk/debug/app-debug.apk
RELEASE_AAB_REL=android/app/build/outputs/bundle/release/app-release.aab
RELEASE_APK_REL=android/app/build/outputs/apk/release/app-release.apk
MAPPING_REL=android/app/build/outputs/mapping/release/mapping.txt
KEYSTORE_PROPS=${LT_KEYSTORE_PROPERTIES:-$STATE/key.properties}

export PATH=/usr/local/bin:/usr/bin:/bin
export HOME="${HOME:-/home/$(id -un)}"
export JAVA_HOME=${LT_JAVA_HOME:-$ROOT/tools/jdk-21}
export ANDROID_HOME=${LT_ANDROID_HOME:-$ROOT/tools/android-sdk}
export ANDROID_SDK_ROOT=$ANDROID_HOME

# A4 verification tools (build-tools 35.0.0; bundletool jar lives in
# tools/, fetched from the upstream Google release).
APKSIGNER=${LT_APKSIGNER:-$ANDROID_HOME/build-tools/35.0.0/apksigner}
AAPT2=${LT_AAPT2:-$ANDROID_HOME/build-tools/35.0.0/aapt2}
BUNDLETOOL_JAR=${LT_BUNDLETOOL_JAR:-$ROOT/tools/bundletool/bundletool-all-1.18.1.jar}

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
AAB_MD5=""
RELEASE_APK_MD5=""
SIGNED_RELEASE="none"   # none | skipped (untagged HEAD) | published
GITHUB_RELEASE="none"     # none | skipped (untagged HEAD) | published

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

# A4: signed release. Runs AFTER release-build (hooks-off web bundle
# + cap sync already done) and after every proof, so a signed artifact
# only exists for a fully-green tree. A3 interaction — fail-closed,
# NOT weakened: bundleRelease/assembleRelease themselves refuse an
# untagged HEAD or a dirty tree, and this stage never invokes them on
# an untagged commit: it gates on an exact tag first and skips cleanly
# (logged; recorded as "skipped" in status.json) when HEAD is
# untagged. A release is cut by tagging the commit and pushing commit
# + tag together; the pristine worktree then sees the tag and the
# stage runs. Any failure here fails the run and nothing publishes.
# Verification is all-or-nothing: apksigner verify (v1+v2+v3),
# bundletool manifest dump (package + git-derived versionCode and
# versionName), and aapt2 badging of the release APK against the same
# expected values.

# GitHub Release (A5): after publish, the github-release stage creates
# a GitHub Release for the tag with the signed AAB + release APK and
# their .sha256 sidecars, changelog from git log since the previous
# tag. It rides the same gate as signed-release (only when a signed
# release was published this run) and fails closed if a release for
# the tag already exists -- never overwrites. /usr/local/sbin/release
# and the Gonas release-gated-publish recipe were NOT reused: they
# publish source trees for web projects (gh-publish scan/publish +
# homepage 200 + tally) and Longtable is not in the recipe's allowed
# list; this publisher ships binary release assets instead.

do_signed_release() {
  local tag expect_code expect_name manifest
  tag=$(git -C "$WT" describe --tags --exact-match HEAD 2>/dev/null || true)
  if [ -z "$tag" ]; then
    say "signed-release: HEAD has no exact tag; skipping (tag the commit to cut a signed release)"
    SIGNED_RELEASE=skipped
    return 0
  fi
  say "signed-release: HEAD tagged $tag; building signed release"
  [ -f "$KEYSTORE_PROPS" ] || { say "signed-release: key.properties missing at $KEYSTORE_PROPS"; return 1; }
  [ -f "$BUNDLETOOL_JAR" ] || { say "signed-release: bundletool jar missing at $BUNDLETOOL_JAR"; return 1; }
  [ -x "$APKSIGNER" ] || { say "signed-release: apksigner missing at $APKSIGNER"; return 1; }
  [ -x "$AAPT2" ] || { say "signed-release: aapt2 missing at $AAPT2"; return 1; }
  (cd "$WT/android" && LT_KEYSTORE_PROPERTIES="$KEYSTORE_PROPS" ./gradlew bundleRelease assembleRelease --console=plain) || return 1
  [ -f "$WT/$RELEASE_AAB_REL" ] || { say "signed-release: AAB missing at $RELEASE_AAB_REL"; return 1; }
  [ -f "$WT/$RELEASE_APK_REL" ] || { say "signed-release: release APK missing at $RELEASE_APK_REL"; return 1; }
  "$APKSIGNER" verify --verbose "$WT/$RELEASE_APK_REL" || return 1
  manifest=$(mktemp)
  "$JAVA_HOME/bin/java" -jar "$BUNDLETOOL_JAR" dump manifest --bundle "$WT/$RELEASE_AAB_REL" >"$manifest" || { rm -f "$manifest"; return 1; }
  expect_code=$(git -C "$WT" rev-list --count HEAD)
  expect_name=${tag#v}
  grep -q "package=\"kitchen.longtable.app\"" "$manifest" || { say "signed-release: AAB manifest package mismatch"; rm -f "$manifest"; return 1; }
  grep -q "android:versionCode=\"$expect_code\"" "$manifest" || { say "signed-release: AAB manifest versionCode mismatch (want $expect_code)"; rm -f "$manifest"; return 1; }
  grep -q "android:versionName=\"$expect_name\"" "$manifest" || { say "signed-release: AAB manifest versionName mismatch (want $expect_name)"; rm -f "$manifest"; return 1; }
  rm -f "$manifest"
  "$AAPT2" dump badging "$WT/$RELEASE_APK_REL" | grep -q "^package: name='kitchen.longtable.app' versionCode='$expect_code' versionName='$expect_name'" || { say "signed-release: release APK badging mismatch (want code=$expect_code name=$expect_name)"; return 1; }
  say "signed-release: verified tag=$tag versionCode=$expect_code versionName=$expect_name"
  SIGNED_RELEASE=published
}

gh_repo_for() { # worktree -> owner/repo derived from origin URL
  local url repo
  url=$(git -C "$1" config --get remote.origin.url 2>/dev/null || true)
  repo=${url#*github.com[:/]}
  repo=${repo%.git}
  case "$repo" in */*) echo "$repo" ;; *) echo "" ;; esac
}

# A5: GitHub Release publisher. Runs AFTER publish, so the assets it
# uploads are the already-published, verified signed artifacts (AAB +
# release APK + .sha256 sidecars) -- never worktree files directly.
# Tag-gated on the same condition as signed-release: it only runs when
# SIGNED_RELEASE=published (which implies HEAD carries an exact tag);
# otherwise it skips cleanly and records "skipped". Changelog is the
# git log since the previous tag (full history when this is the first
# tag). Fail-closed: if a release for the tag already exists, the
# stage FAILS -- never force-delete or overwrite an existing release;
# re-publishing a tag is a human call.
do_github_release() {
  local tag repo notes prev
  if [ "$SIGNED_RELEASE" != published ]; then
    say "github-release: no signed release this run (signed_release=$SIGNED_RELEASE); skipping"
    GITHUB_RELEASE=skipped
    return 0
  fi
  tag=$(git -C "$WT" describe --tags --exact-match HEAD 2>/dev/null || true)
  [ -n "$tag" ] || { say "github-release: signed_release=published but HEAD has no exact tag; refusing"; return 1; }
  [ -f "$PUBLISH_AAB" ] || { say "github-release: published AAB missing at $PUBLISH_AAB"; return 1; }
  [ -f "$PUBLISH_RELEASE_APK" ] || { say "github-release: published release APK missing at $PUBLISH_RELEASE_APK"; return 1; }
  [ -f "$PUBLISH_AAB.sha256" ] || { say "github-release: AAB checksum sidecar missing at $PUBLISH_AAB.sha256"; return 1; }
  [ -f "$PUBLISH_RELEASE_APK.sha256" ] || { say "github-release: release APK checksum sidecar missing at $PUBLISH_RELEASE_APK.sha256"; return 1; }
  command -v gh >/dev/null 2>&1 || { say "github-release: gh CLI not found"; return 1; }
  repo=$(gh_repo_for "$WT")
  [ -n "$repo" ] || { say "github-release: could not derive owner/repo from origin"; return 1; }
  if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
    say "github-release: release $tag already exists on $repo; refusing to overwrite (delete it by hand if a re-publish is intended)"
    return 1
  fi
  notes=$(mktemp)
  {
    echo "Longtable $tag"
    echo ""
    echo "versionCode $(git -C "$WT" rev-list --count HEAD), versionName ${tag#v}."
    echo "Signed release APK + AAB, with SHA-256 sidecars."
    echo ""
    echo "Checksums:"
    cat "$PUBLISH_AAB.sha256" "$PUBLISH_RELEASE_APK.sha256"
    echo ""
    echo "Changes:"
    prev=$(git -C "$WT" describe --tags --abbrev=0 HEAD^ 2>/dev/null || true)
    if [ -n "$prev" ]; then
      git -C "$WT" log "$prev..HEAD" --format='- %s (%h)'
    else
      git -C "$WT" log --format='- %s (%h)'
    fi
  } >"$notes" || { rm -f "$notes"; return 1; }
  gh release create "$tag" --repo "$repo" --title "Longtable $tag" --notes-file "$notes" \
    "$PUBLISH_RELEASE_APK" "$PUBLISH_AAB" "$PUBLISH_RELEASE_APK.sha256" "$PUBLISH_AAB.sha256" || { rm -f "$notes"; return 1; }
  rm -f "$notes"
  say "github-release: published https://github.com/$repo/releases/tag/$tag"
  GITHUB_RELEASE=published
}

publish_one() { # src dst
  cp "$1" "$2.tmp"
  mv "$2.tmp" "$2"
}

write_sha256() { # file
  (cd "$(dirname "$1")" && sha256sum "$(basename "$1")" > "$1.sha256.tmp" && mv "$1.sha256.tmp" "$1.sha256")
}

do_publish() {
  publish_one "$WT/$APK_REL" "$PUBLISH_APK"
  APK_MD5=$(md5sum "$PUBLISH_APK" | cut -d' ' -f1)
  say "published $PUBLISH_APK md5=$APK_MD5"
  if [ "$SIGNED_RELEASE" = published ]; then
    publish_one "$WT/$RELEASE_AAB_REL" "$PUBLISH_AAB"
    publish_one "$WT/$RELEASE_APK_REL" "$PUBLISH_RELEASE_APK"
    AAB_MD5=$(md5sum "$PUBLISH_AAB" | cut -d' ' -f1)
    RELEASE_APK_MD5=$(md5sum "$PUBLISH_RELEASE_APK" | cut -d' ' -f1)
    write_sha256 "$PUBLISH_AAB"
    write_sha256 "$PUBLISH_RELEASE_APK"
    say "published $PUBLISH_AAB md5=$AAB_MD5"
    say "published $PUBLISH_RELEASE_APK md5=$RELEASE_APK_MD5"
    if [ -f "$WT/$MAPPING_REL" ]; then
      publish_one "$WT/$MAPPING_REL" "$PUBLISH_MAPPING"
      write_sha256 "$PUBLISH_MAPPING"
      say "published $PUBLISH_MAPPING"
    else
      say "publish: no mapping.txt produced (minifyEnabled false); skipping mapping publish"
    fi
  fi
}

write_status() {
  CI_STAGES="$STAGE_RESULTS" CI_COMMIT="$TARGET_HASH" \
  CI_RESULT="$1" CI_FAILED_STAGE="$FAILED_STAGE" \
  CI_STARTED_AT="$2" CI_FINISHED_AT="$3" CI_DURATION_S="$4" \
  CI_APK_MD5="$APK_MD5" CI_LOG="$5" \
  CI_AAB_MD5="$AAB_MD5" CI_RELEASE_APK_MD5="$RELEASE_APK_MD5" \
  CI_SIGNED_RELEASE="$SIGNED_RELEASE" \
  CI_GITHUB_RELEASE="$GITHUB_RELEASE" \
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
    "aab_md5": os.environ.get("CI_AAB_MD5", "") or None,
    "release_apk_md5": os.environ.get("CI_RELEASE_APK_MD5", "") or None,
    "signed_release": os.environ.get("CI_SIGNED_RELEASE", "none"),
    "github_release": os.environ.get("CI_GITHUB_RELEASE", "none"),
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
  STAGE_RESULTS=""; FAILED_STAGE=""; APK_MD5=""; AAB_MD5=""; RELEASE_APK_MD5=""; SIGNED_RELEASE="none"; GITHUB_RELEASE="none"; FLEET_UP=""
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
    stage signed-release  do_signed_release &&
    stage publish         do_publish &&
    stage github-release  do_github_release
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
