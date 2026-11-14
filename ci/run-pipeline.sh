#!/bin/bash
# run-pipeline.sh — Longtable on-box CI pipeline. See ci/README.md.
#
# Triggered by longtable-ci.service (longtable-ci.path watches
# .git/refs/heads/main; longtable-ci.timer is a 10-minute fallback).
# Installed into the ops CI state dir by ci/install-ci.sh; the copy in
# the repo is the source of truth. The pipeline skeleton (flock,
# stage runner, status/history logging, always-teardown, main loop)
# comes from the shared CI lib ops/shared/ci/ci-lib.sh; this script
# holds the Longtable stages only.
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
# Shared pipeline skeleton (ops/shared/ci/ci-lib.sh): flock, stage
# runner, status/history logging, always-teardown, main loop. The
# bootstrap above stays here — the lib cannot locate itself — and
# LT_* operator overrides keep working via the CI_* mapping below.
CI_LIB=$ROOT/ops/shared/ci/ci-lib.sh
[ -f "$CI_LIB" ] || { echo "[ci] shared CI lib missing at $CI_LIB" >&2; exit 1; }
. "$CI_LIB"
CI_ROOT=$ROOT
CI_REPO=${CI_REPO:-${LT_REPO:-$ROOT/code/longtable}}
CI_STATE_DIR=${CI_STATE_DIR:-${LT_CI_STATE:-$ROOT/ops/longtable-ci}}
REPO=$CI_REPO
STATE=$CI_STATE_DIR
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

# --- serialization (shared lib) ---------------------------------------------
ci_acquire_lock "$LOCK_FILE"

# --- run bookkeeping --------------------------------------------------------
# Stage results live in the shared lib (CI_STAGE_RESULTS /
# CI_FAILED_STAGE, reset per run by ci_reset_run_state).
FLEET_UP=""        # set once fleet provisioning is attempted
APK_MD5=""
AAB_MD5=""
RELEASE_APK_MD5=""
SIGNED_RELEASE="none"   # none | skipped (untagged HEAD) | published
GITHUB_RELEASE="none"     # none | skipped (untagged HEAD) | published

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
  local tag expect_code expect_name manifest badging_file
  tag=$(git -C "$WT" describe --tags --exact-match HEAD 2>/dev/null || true)
  if [ -z "$tag" ]; then
    ci_say "signed-release: HEAD has no exact tag; skipping (tag the commit to cut a signed release)"
    SIGNED_RELEASE=skipped
    return 0
  fi
  ci_say "signed-release: HEAD tagged $tag; building signed release"
  [ -f "$KEYSTORE_PROPS" ] || { ci_say "signed-release: key.properties missing at $KEYSTORE_PROPS"; return 1; }
  [ -f "$BUNDLETOOL_JAR" ] || { ci_say "signed-release: bundletool jar missing at $BUNDLETOOL_JAR"; return 1; }
  [ -x "$APKSIGNER" ] || { ci_say "signed-release: apksigner missing at $APKSIGNER"; return 1; }
  [ -x "$AAPT2" ] || { ci_say "signed-release: aapt2 missing at $AAPT2"; return 1; }
  (cd "$WT/android" && LT_KEYSTORE_PROPERTIES="$KEYSTORE_PROPS" ./gradlew bundleRelease assembleRelease --console=plain) || return 1
  [ -f "$WT/$RELEASE_AAB_REL" ] || { ci_say "signed-release: AAB missing at $RELEASE_AAB_REL"; return 1; }
  [ -f "$WT/$RELEASE_APK_REL" ] || { ci_say "signed-release: release APK missing at $RELEASE_APK_REL"; return 1; }
  "$APKSIGNER" verify --verbose "$WT/$RELEASE_APK_REL" || return 1
  manifest=$(mktemp)
  "$JAVA_HOME/bin/java" -jar "$BUNDLETOOL_JAR" dump manifest --bundle "$WT/$RELEASE_AAB_REL" >"$manifest" || { rm -f "$manifest"; return 1; }
  expect_code=$(git -C "$WT" rev-list --count HEAD)
  expect_name=${tag#v}
  grep -q "package=\"kitchen.longtable.app\"" "$manifest" || { ci_say "signed-release: AAB manifest package mismatch"; rm -f "$manifest"; return 1; }
  grep -q "android:versionCode=\"$expect_code\"" "$manifest" || { ci_say "signed-release: AAB manifest versionCode mismatch (want $expect_code)"; rm -f "$manifest"; return 1; }
  grep -q "android:versionName=\"$expect_name\"" "$manifest" || { ci_say "signed-release: AAB manifest versionName mismatch (want $expect_name)"; rm -f "$manifest"; return 1; }
  rm -f "$manifest"
  # NOTE (2026-11-14, v0.2.0): do NOT pipe aapt2 into grep -q here.
  # Under `set -o pipefail`, grep -q exits after the first line and
  # aapt2 dies with SIGPIPE (exit 141) on its next write, which
  # pipefail reports as a check failure even when the badging
  # matches (reproduced 38/40 running the exact pipeline command
  # by hand). Capture to a temp file first (as the bundletool
  # manifest check above does), then grep the file. Same pass/fail
  # semantics; the mismatch message now prints the actual line.
  badging_file=$(mktemp)
  "$AAPT2" dump badging "$WT/$RELEASE_APK_REL" >"$badging_file" || { rm -f "$badging_file"; return 1; }
  grep -q "^package: name='kitchen.longtable.app' versionCode='$expect_code' versionName='$expect_name'" "$badging_file" || { ci_say "signed-release: release APK badging mismatch (want code=$expect_code name=$expect_name; got: $(head -1 "$badging_file"))"; rm -f "$badging_file"; return 1; }
  rm -f "$badging_file"
  ci_say "signed-release: verified tag=$tag versionCode=$expect_code versionName=$expect_name"
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
    ci_say "github-release: no signed release this run (signed_release=$SIGNED_RELEASE); skipping"
    GITHUB_RELEASE=skipped
    return 0
  fi
  tag=$(git -C "$WT" describe --tags --exact-match HEAD 2>/dev/null || true)
  [ -n "$tag" ] || { ci_say "github-release: signed_release=published but HEAD has no exact tag; refusing"; return 1; }
  [ -f "$PUBLISH_AAB" ] || { ci_say "github-release: published AAB missing at $PUBLISH_AAB"; return 1; }
  [ -f "$PUBLISH_RELEASE_APK" ] || { ci_say "github-release: published release APK missing at $PUBLISH_RELEASE_APK"; return 1; }
  [ -f "$PUBLISH_AAB.sha256" ] || { ci_say "github-release: AAB checksum sidecar missing at $PUBLISH_AAB.sha256"; return 1; }
  [ -f "$PUBLISH_RELEASE_APK.sha256" ] || { ci_say "github-release: release APK checksum sidecar missing at $PUBLISH_RELEASE_APK.sha256"; return 1; }
  command -v gh >/dev/null 2>&1 || { ci_say "github-release: gh CLI not found"; return 1; }
  repo=$(gh_repo_for "$WT")
  [ -n "$repo" ] || { ci_say "github-release: could not derive owner/repo from origin"; return 1; }
  if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
    ci_say "github-release: release $tag already exists on $repo; refusing to overwrite (delete it by hand if a re-publish is intended)"
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
  ci_say "github-release: published https://github.com/$repo/releases/tag/$tag"
  GITHUB_RELEASE=published
}

do_publish() {
  ci_publish_one "$WT/$APK_REL" "$PUBLISH_APK"
  APK_MD5=$(md5sum "$PUBLISH_APK" | cut -d' ' -f1)
  ci_say "published $PUBLISH_APK md5=$APK_MD5"
  if [ "$SIGNED_RELEASE" = published ]; then
    ci_publish_one "$WT/$RELEASE_AAB_REL" "$PUBLISH_AAB"
    ci_publish_one "$WT/$RELEASE_APK_REL" "$PUBLISH_RELEASE_APK"
    AAB_MD5=$(md5sum "$PUBLISH_AAB" | cut -d' ' -f1)
    RELEASE_APK_MD5=$(md5sum "$PUBLISH_RELEASE_APK" | cut -d' ' -f1)
    ci_write_sha256 "$PUBLISH_AAB"
    ci_write_sha256 "$PUBLISH_RELEASE_APK"
    ci_say "published $PUBLISH_AAB md5=$AAB_MD5"
    ci_say "published $PUBLISH_RELEASE_APK md5=$RELEASE_APK_MD5"
    if [ -f "$WT/$MAPPING_REL" ]; then
      ci_publish_one "$WT/$MAPPING_REL" "$PUBLISH_MAPPING"
      ci_write_sha256 "$PUBLISH_MAPPING"
      ci_say "published $PUBLISH_MAPPING"
    else
      ci_say "publish: no mapping.txt produced (minifyEnabled false); skipping mapping publish"
    fi
  fi
}

run_one() {
  TARGET_HASH=$1; CI_COMMIT=$TARGET_HASH
  local short run_id log started finished result
  short=$(git -C "$REPO" rev-parse --short "$TARGET_HASH")
  run_id="$(date +%Y%m%d-%H%M%S)-$short"
  log="$LOGS/$run_id.log"
  started=$(date -Iseconds)
  ci_reset_run_state; APK_MD5=""; AAB_MD5=""; RELEASE_APK_MD5=""; SIGNED_RELEASE="none"; GITHUB_RELEASE="none"; FLEET_UP=""; CI_EXTRA_JSON=""
  local t0=$SECONDS
  ci_say "run $run_id commit $TARGET_HASH"
  {
    ci_say "run $run_id commit $TARGET_HASH (full log: $log)"
    ci_stage checkout        do_checkout  &&
    ci_stage npm-ci          do_npm_ci    &&
    ci_stage typecheck       do_typecheck &&
    ci_stage lint            do_lint      &&
    ci_stage unit-tests      do_unit      &&
    ci_stage appview-tests   do_appview   &&
    ci_stage web-build       do_build     &&
    ci_stage cap-sync        do_capsync   &&
    ci_stage apk             do_apk       &&
    ci_stage fleet-provision do_fleet_provision &&
    ci_stage e2e-gate        do_e2e       &&
    ci_stage migration-proof do_migration &&
    ci_stage proof-p2p       do_proof proof-p2p &&
    ci_stage proof-friends   do_proof proof-friends &&
    ci_stage proof-public    do_proof proof-public &&
    ci_stage proof-thirdparty do_proof proof-thirdparty &&
    ci_stage proof-importer  do_proof proof-importer &&
    ci_stage proof-localapi  do_proof proof-localapi &&
    ci_stage proof-hubfail   do_proof proof-hubfail &&
    ci_stage release-build   do_release_build &&
    ci_stage signed-release  do_signed_release &&
    ci_stage publish         do_publish &&
    ci_stage github-release  do_github_release
    true
  } >>"$log" 2>&1
  if [ -n "$FLEET_UP" ]; then
    { ci_run_teardown fleet-teardown do_fleet_teardown; } >>"$log" 2>&1
  fi
  finished=$(date -Iseconds)
  if [ -n "$CI_FAILED_STAGE" ]; then result=failed; else result=success; fi
  CI_EXTRA_JSON=$(printf '{"apk_md5": %s, "aab_md5": %s, "release_apk_md5": %s, "signed_release": %s, "github_release": %s}' "$(ci_json_str "$APK_MD5")" "$(ci_json_str "$AAB_MD5")" "$(ci_json_str "$RELEASE_APK_MD5")" "$(ci_json_str "$SIGNED_RELEASE")" "$(ci_json_str "$GITHUB_RELEASE")")
  ci_write_status "$result" "$started" "$finished" "$((SECONDS-t0))" "$log"
  ci_say "run $run_id result=$result failed_stage=${CI_FAILED_STAGE:-none} duration=$((SECONDS-t0))s log=$log"
  if [ "$result" = success ]; then
    git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"
  else
    ci_say "failed worktree kept for inspection at $WT (wiped by next run)"
  fi
}
# --- main loop (shared lib): process HEAD, catch up if it moved ------------
ci_main_loop run_one
