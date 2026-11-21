#!/bin/bash
# run-pipeline.sh — Longtable on-box CI pipeline. See ci/README.md.
#
# Triggered by longtable-ci.service (longtable-ci.path watches
# .git/refs/heads/main; longtable-ci-tag.path watches .git/refs/tags
# and .git/packed-refs so tagging an already-processed commit re-runs
# the pipeline for the tag — see lt_main_loop; the longtable-ci.timer
# is a 10-minute fallback).
# Installed into the ops CI state dir by ci/install-ci.sh; the copy in
# the repo is the source of truth. The pipeline skeleton (flock,
# stage runner, status/history logging, always-teardown) comes from
# the shared CI lib ops/shared/ci/ci-lib.sh; this script holds the
# Longtable stages only. The main loop is Longtable-local
# (lt_main_loop at the end): the shared lib's ci_main_loop marks a
# commit processed unconditionally after run_fn, which marks failed
# runs processed (M2) — see there.
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
# otherwise; the A3 check itself is never relaxed. Tag a commit with
# a SIGNED tag (`git tag -s`, verified by the tag-verify stage
# against the pinned operator key) to cut a signed release. Verified
# artifacts (apksigner
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
# Sec L21: the shared lib is sourced by path and unpinned, so verify
# it against the repo-recorded pin (ci/ci-lib.sha256) BEFORE sourcing
# it. A hash mismatch fails closed: the lib is shared infrastructure,
# and a drifted lib must be reviewed + re-pinned, never silently
# executed. The pin lives in the repo (reviewed, committed); the lib
# itself lives outside the repo, so a commit cannot tamper with it —
# the pin only guards against an unreviewed local change to the lib.
CI_REPO=${CI_REPO:-${LT_REPO:-$ROOT/code/longtable}}
CI_LIB=$ROOT/ops/shared/ci/ci-lib.sh
[ -f "$CI_LIB" ] || { echo "[ci] shared CI lib missing at $CI_LIB" >&2; exit 1; }
CI_LIB_PIN=$CI_REPO/ci/ci-lib.sha256
[ -f "$CI_LIB_PIN" ] || { echo "[ci] shared CI lib pin missing at $CI_LIB_PIN" >&2; exit 1; }
CI_LIB_PIN_HASH=$(grep -v '^[[:space:]]*#' "$CI_LIB_PIN" | awk '{print $1}' | head -1)
[ -n "$CI_LIB_PIN_HASH" ] || { echo "[ci] shared CI lib pin empty at $CI_LIB_PIN" >&2; exit 1; }
[ "$(sha256sum "$CI_LIB" | cut -d' ' -f1)" = "$CI_LIB_PIN_HASH" ] || { echo "[ci] shared CI lib hash mismatch: $CI_LIB differs from the pin in $CI_LIB_PIN — review the lib diff and re-pin" >&2; exit 1; }
. "$CI_LIB"
CI_ROOT=$ROOT
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
# Operator-pinned tag-signing public key (Wave 6C): the tag-verify stage
# checks every HEAD tag's signature against this key. Ops-side file,
# never in the repo; absent until the operator creates a signing key
# and pins its public half here (see ci/README.md "Signed tags").
TAG_SIGNING_KEY=${LT_TAG_SIGNING_KEY:-$STATE/tag-signing-key.pub}
# Hash-pinned privacy scanner (review H3): the scanner the pipeline
# executes lives in $STATE/scanner/, installed by hand with
# ci/pin-scanner.sh from a reviewed rev — never the worktree's own
# ci/ copy, which would let a commit neuter its own gate.
PINNED_SCANNER_DIR=$STATE/scanner

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

# --- drift check (Sec L21) ---------------------------------------------------
# The installed pipeline must track the repo: a stale installed copy
# silently runs old gates (the pre-H3 installed copy ran the worktree
# scanner instead of the pinned one, skipped commit/tag message scans,
# and used the shared lib's main loop that marked failed runs
# processed). Fail closed on drift; the operator re-runs
# ci/install-ci.sh after any ci/ change, before the next run can go
# green. This check runs before the lock is taken, so a drifted run
# fails fast without holding the fleet lock.
for _drift_f in run-pipeline.sh history-scan.sh; do
  if [ -f "$REPO/ci/$_drift_f" ]; then
    cmp -s "$STATE/$_drift_f" "$REPO/ci/$_drift_f" || { ci_say "drift: installed $STATE/$_drift_f differs from $REPO/ci/$_drift_f — run ci/install-ci.sh"; exit 1; }
  fi
done

# filter_mapped_hits <baseline-json> <mapped-hits-file>: print the
# mapped hits (label:line:class, one per line) that are NOT in the
# ops history-scan baseline's message_hits. Used by the commit/tag
# message scan (S25) and the release-notes scan: a hit the operator
# already reviewed and baselined is known-benign; anything else fails
# the run. A missing/unreadable baseline filters NOTHING (fail closed
# — the run then fails on any message hit, including known residue).
filter_mapped_hits() {
  python3 - "$1" "$2" <<'PYEOF'
import json, sys
try:
    known = set(json.load(open(sys.argv[1])).get("message_hits", []))
except Exception as e:
    print(f"filter: baseline unreadable ({sys.argv[1]}): {e}; filtering nothing", file=sys.stderr)
    known = set()
for line in open(sys.argv[2]):
    line = line.strip()
    if line and line not in known:
        print(line)
PYEOF
}

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
# Verify the hash-pinned scanner (H3) before any use: the pinned
# copy (script + patterns + allowlist) must match the operator-written
# sha256sums manifest byte for byte. A missing pin, a hash mismatch,
# or a missing file fails the run closed — a commit can never weaken
# the gate that judges it, because the gate's code does not come from
# the commit. The repo's ci/ copy is only the source the operator
# re-pins FROM (after reviewing its diff); it is never executed here.
pinned_scanner_check() {
  local dir=$PINNED_SCANNER_DIR
  [ -d "$dir" ] || { ci_say "pinned scanner: missing directory $dir (run ci/pin-scanner.sh)"; return 1; }
  [ -f "$dir/sha256sums" ] || { ci_say "pinned scanner: missing pin manifest $dir/sha256sums"; return 1; }
  [ -x "$dir/privacy-scan.sh" ] || { ci_say "pinned scanner: privacy-scan.sh missing/not executable in $dir"; return 1; }
  (cd "$dir" && sha256sum -c sha256sums >/dev/null) || { ci_say "pinned scanner: hash mismatch against $dir/sha256sums; refusing to scan with an unverified scanner"; return 1; }
  ci_say "pinned scanner: verified against $dir/sha256sums"
}
# Privacy gate (secret-scan): scan the pristine worktree for secrets,
# private addresses/paths, and PII before anything builds, with the
# HASH-PINNED scanner (H3). The generic pattern classes live in the
# pinned patterns file (EREs, no real values); specific values live
# only in the ops-side $STATE/privacy-secrets (0600, read with
# grep -f). A missing scanner/pin, a missing secrets file, or any hit
# fails the run. Commit and tag messages are scanned too (M18/S25):
# they are not in the tree, so the tree scan cannot see them. The
# message scan covers every commit the release notes will quote
# (previous-tag..HEAD — a batch push can land several commits in one
# run, and scanning HEAD only would miss a secret in an intermediate
# subject), plus the HEAD tag annotation, BEFORE any build or publish
# — which closes S25: the release-notes scan in do_github_release is
# defense in depth on the generated notes, not the first look at the
# subjects. Hits already recorded in the ops history-scan baseline
# (message_hits) are known-benign and filtered out by exact
# (rev, line, class) match via filter_mapped_hits; anything else fails
# the run. A missing/unreadable baseline filters nothing (fail closed).
# See ci/README.md.
do_secret_scan() {
  pinned_scanner_check || return 1
  "$PINNED_SCANNER_DIR/privacy-scan.sh" --secrets "$STATE/privacy-secrets" "$WT" || return 1
  local msg_tmp prev revs tag rc
  msg_tmp=$(mktemp -d)
  prev=$(git -C "$WT" describe --tags --abbrev=0 HEAD^ 2>/dev/null || true)
  if [ -n "$prev" ]; then
    revs=$(git -C "$WT" rev-list "$prev..HEAD") || { rm -rf "$msg_tmp"; return 1; }
  else
    revs="$TARGET_HASH"
  fi
  : > "$msg_tmp/messages.txt"
  for rev in $revs; do
    {
      echo "---msg $rev---"
      git -C "$WT" show -s --format=%B "$rev"
    } >> "$msg_tmp/messages.txt" || { rm -rf "$msg_tmp"; return 1; }
  done
  tag=$(git -C "$WT" describe --tags --exact-match HEAD 2>/dev/null || true)
  : > "$msg_tmp/tags.txt"
  if [ -n "$tag" ]; then
    {
      echo "---tag $tag---"
      git -C "$WT" for-each-ref --format='%(contents)' "refs/tags/$tag"
    } >> "$msg_tmp/messages.txt" || { rm -rf "$msg_tmp"; return 1; }
    printf '%s\n' "$tag" > "$msg_tmp/tags.txt"
  fi
  rc=0
  "$PINNED_SCANNER_DIR/privacy-scan.sh" --secrets "$STATE/privacy-secrets" "$msg_tmp/messages.txt" > "$msg_tmp/scan_out" 2>&1 || rc=$?
  if [ "$rc" = 2 ]; then rm -rf "$msg_tmp"; return 1; fi
  if [ "$rc" = 1 ]; then
    # Map scanner hits back to their rev/tag by section header (same
    # mapping as ci/history-scan.sh: a header is only trusted when it
    # matches ---msg <40-hex>--- exactly, or ---tag <name>--- with
    # <name> a real tag, so a message line that merely looks like a
    # header cannot misattribute a hit), then filter known-baseline
    # hits. Scanner output is file:line:class only — no content.
    grep -F "$msg_tmp/messages.txt:" "$msg_tmp/scan_out" | sed "s|^$msg_tmp/messages.txt:||" > "$msg_tmp/rawhits" || true
    if [ ! -s "$msg_tmp/rawhits" ]; then
      ci_say "secret-scan: scanner reported hits but none could be mapped (unexpected output format); failing closed"
      rm -rf "$msg_tmp"
      return 1
    fi
    python3 - "$msg_tmp/messages.txt" "$msg_tmp/rawhits" "$msg_tmp/tags.txt" > "$msg_tmp/mapped" <<'PYEOF'
import re, sys
msg_path, rawhits_path, tags_path = sys.argv[1:4]
tags = {l.strip() for l in open(tags_path) if l.strip()}
sections = []
with open(msg_path) as f:
    for i, line in enumerate(f, start=1):
        line = line.rstrip('\n')
        m = re.fullmatch(r'---msg ([0-9a-f]{40})---', line)
        if m:
            sections.append((i, m.group(1)[:12]))
            continue
        m = re.fullmatch(r'---tag ([^ ]+)---', line)
        if m and m.group(1) in tags:
            sections.append((i, 'tag:' + m.group(1)))
out = []
for raw in open(rawhits_path):
    raw = raw.strip()
    if not raw:
        continue
    num, _, cls = raw.rpartition(':')
    lineno = int(num)
    label, start = None, None
    for s_line, s_label in reversed(sections):
        if s_line <= lineno:
            label, start = s_label, s_line
            break
    if label is None:
        continue
    out.append(f'{label}:{lineno - start}:{cls}')
if out:
    print('\n'.join(sorted(set(out))))
PYEOF
    filter_mapped_hits "$STATE/history-scan-baseline.json" "$msg_tmp/mapped" > "$msg_tmp/unknown" || { rm -rf "$msg_tmp"; return 1; }
    if [ -s "$msg_tmp/unknown" ]; then
      ci_say "secret-scan: unknown commit/tag message hits (not in the history-scan baseline):"
      sed 's/^/secret-scan:   /' "$msg_tmp/unknown"
      rm -rf "$msg_tmp"
      return 1
    fi
    ci_say "secret-scan: message hits all known (history-scan baseline)"
  fi
  rm -rf "$msg_tmp"
  return 0
}
# Legacy-hub digest check (review C1): the migration in src/hubs/hubs.ts
# matches the pre-scrub default hub by FNV-1a-64 digest, and the digests
# committed by 440c8ac hashed strings that never shipped — so the
# migration could never fire and no test caught it. The check script
# re-derives the expected digests from git history (git show of the
# pre-scrub file) and compares them against the committed constants,
# printing digests/match booleans only. It runs in the pristine worktree
# so it tests the committed constants; it fails closed when the
# pre-scrub rev is unavailable (e.g. shallow history) or any digest
# mismatches. Runs right after secret-scan, before anything builds.
do_legacy_digests() {
  "$WT/ci/check-legacy-hub-digests.py" "$WT"
}
# versionCode monotonicity guard: versionCode is `git rev-list --count
# HEAD` (android/app/build.gradle), so it is monotonic by construction
# — unless history is rewritten (rebase / force-push dropping commits),
# in which case a new release would ship a LOWER versionCode than the
# last tagged release and Play would refuse it (or worse, devices
# would see a downgrade). Compare HEAD's count against the most recent
# tag reachable from HEAD: in un-rewritten history the tag is an
# ancestor, so its count can never exceed HEAD's. Fails closed when
# either count cannot be derived. No tag reachable yet (before the
# first release) skips cleanly — there is nothing to go backwards from.
# The count is recorded as VERSION_CODE for status.json (run_one).
VERSION_CODE=""
do_version_guard() {
  local current tag tag_count
  current=$(git -C "$WT" rev-list --count HEAD) || return 1
  case "$current" in ''|*[!0-9]*) ci_say "version-guard: could not derive versionCode (rev-list --count HEAD)"; return 1 ;; esac
  VERSION_CODE="$current"
  tag=$(git -C "$WT" describe --tags --abbrev=0 HEAD 2>/dev/null || true)
  if [ -z "$tag" ]; then
    ci_say "version-guard: no reachable tag; versionCode $current has nothing to go backwards from"
    return 0
  fi
  tag_count=$(git -C "$WT" rev-list --count "$tag") || return 1
  case "$tag_count" in ''|*[!0-9]*) ci_say "version-guard: could not derive versionCode at $tag"; return 1 ;; esac
  if [ "$current" -lt "$tag_count" ]; then
    ci_say "version-guard: versionCode $current < $tag_count at tag $tag — history rewrite; refusing"
    return 1
  fi
  ci_say "version-guard: versionCode $current >= $tag_count ($tag); monotonic"
}
# Tag-signature verification (Wave 6C). Runs ONLY when HEAD carries a
# tag (one or more) and SKIPS cleanly on untagged commits. Every tag
# pointing at HEAD must carry a valid signature from the
# operator-pinned key ($TAG_SIGNING_KEY, ops-side, never in the repo):
# the pinned public key is imported into a throwaway GNUPGHOME, its
# fingerprint is derived from the key itself (so there is no second
# fingerprint file to drift), and `git verify-tag --raw` must report
# VALIDSIG for exactly that fingerprint, with no BADSIG / EXPKEYSIG /
# REVKEYSIG / NO_PUBKEY line. Trust is not consulted — the pin is the
# exact key, not a trust chain. Fails closed: an unsigned tag, a tag
# signed by any other key, and a tagged HEAD with no pinned key
# configured all fail the run BEFORE any build or publish, so a
# signed release can only ever come from a verified tag. A missing
# pinned-key file on an UNTAGGED HEAD is not an error (nothing to
# verify); it only fails when a tag is present. Lightweight tags have
# no signature and fail here by design — releases are cut with
# `git tag -s` (see ci/README.md "Signed tags").
do_tag_verify() {
  local tags tag key_fpr tmp_gnupg verify_out
  tags=$(git -C "$WT" tag --points-at HEAD | sort)
  if [ -z "$tags" ]; then
    ci_say "tag-verify: HEAD has no tag; nothing to verify"
    return 0
  fi
  if [ ! -s "$TAG_SIGNING_KEY" ]; then
    ci_say "tag-verify: HEAD is tagged but no pinned operator key at $TAG_SIGNING_KEY — tags cannot be verified until an operator key is pinned; refusing"
    return 1
  fi
  tmp_gnupg=$(mktemp -d)
  chmod 700 "$tmp_gnupg"
  if ! GNUPGHOME="$tmp_gnupg" gpg --batch --quiet --import "$TAG_SIGNING_KEY" 2>/dev/null; then
    ci_say "tag-verify: could not import pinned key at $TAG_SIGNING_KEY"
    rm -rf "$tmp_gnupg"
    return 1
  fi
  key_fpr=$(GNUPGHOME="$tmp_gnupg" gpg --batch --with-colons --list-keys 2>/dev/null | awk -F: '/^fpr:/ {print $10; exit}')
  case "$key_fpr" in
    ''|*[!0-9A-F]*)
      ci_say "tag-verify: could not derive a fingerprint from the pinned key at $TAG_SIGNING_KEY"
      rm -rf "$tmp_gnupg"
      return 1
      ;;
  esac
  ci_say "tag-verify: pinned key fingerprint $key_fpr"
  for tag in $tags; do
    verify_out=$(GNUPGHOME="$tmp_gnupg" git -C "$WT" verify-tag --raw "$tag" 2>&1) || {
      ci_say "tag-verify: tag $tag has no valid signature (git verify-tag failed); refusing"
      rm -rf "$tmp_gnupg"
      return 1
    }
    if printf '%s\n' "$verify_out" | grep -q -e BADSIG -e EXPKEYSIG -e REVKEYSIG -e NO_PUBKEY; then
      ci_say "tag-verify: tag $tag signature is bad/expired/revoked/unverifiable; refusing"
      rm -rf "$tmp_gnupg"
      return 1
    fi
    if ! printf '%s\n' "$verify_out" | grep -q "VALIDSIG $key_fpr"; then
      ci_say "tag-verify: tag $tag is not signed by the pinned key $key_fpr; refusing"
      rm -rf "$tmp_gnupg"
      return 1
    fi
    ci_say "tag-verify: tag $tag signature valid for pinned key $key_fpr"
  done
  rm -rf "$tmp_gnupg"
  return 0
}
do_npm_ci()    { (cd "$WT" && npm ci --no-audit --no-fund); }
do_typecheck() { (cd "$WT" && npm run typecheck); }
do_lint()      { (cd "$WT" && npm run lint); }
do_unit()      { (cd "$WT" && npm test); }
# CSP assertion (review L5): the Content-Security-Policy must survive
# into the BUILT index.html — the vite plugin injects it at build
# time, so only the built artifact proves it. Checks the meta tag is
# present, script-src is exactly 'self' + 'wasm-unsafe-eval' (no
# third-party or inline script), and script-src never allows
# 'unsafe-inline' (style-src legitimately uses it; this check is
# scoped to the script-src directive only).
assert_csp() { # dist dir
  local html="$1/index.html"
  [ -f "$html" ] || { ci_say "csp: built index.html missing at $html"; return 1; }
  grep -q 'http-equiv="Content-Security-Policy"' "$html" || { ci_say "csp: no CSP meta tag in built index.html"; return 1; }
  grep -q "script-src 'self' 'wasm-unsafe-eval'" "$html" || { ci_say "csp: script-src directive missing or changed in built index.html"; return 1; }
  if grep -o "script-src[^;]*" "$html" | grep -q 'unsafe-inline'; then
    ci_say "csp: script-src allows unsafe-inline in built index.html"
    return 1
  fi
}
# Debug-hook strings must be absent from a directory of shipped files
# (review L6): the hooks are proof-only and expose secrets/sessions,
# so this check runs on extracted archives, not just dist/.
hooks_absent_dir() { # dir
  local d=$1 h
  [ -d "$d" ] || { ci_say "hooks: directory missing: $d"; return 1; }
  for h in __ltFriends __ltPublic __ltSecrets; do
    if grep -rq "$h" "$d"; then ci_say "hooks: $h present in shipped files under $d"; return 1; fi
  done
}
# Proof build: debug hooks ON (VITE_LT_DEBUG_HOOKS=1). The assertion
# pins the wiring: if the hooks ever vanish from the proof bundle, the
# proofs would fail obscurely — fail here, loudly, instead.
do_build()     {
  local turn_pw=""
  if [ -f "$STATE/dev-turn-password" ]; then turn_pw=$(cat "$STATE/dev-turn-password"); fi
  (cd "$WT" && VITE_LT_DEBUG_HOOKS=1 VITE_LT_DEV_TURN_PASSWORD="$turn_pw" npm run build) &&
  grep -rq '__ltFriends' "$WT/dist/assets" &&
  grep -rq '__ltPublic' "$WT/dist/assets" &&
  grep -rq '__ltSecrets' "$WT/dist/assets" &&
  assert_csp "$WT/dist"
}
# Release build: same tree, hooks OFF and no dev TURN password
# injected, rebuilt after all proofs pass; its APK is the one
# do_publish ships. Fails closed if a hook string or any dev TURN
# credential (the burned one, or the rotated one) survives in the
# bundle, or any literal from the shared ops-side privacy-secrets file survives
# anywhere in dist/ -- not just dist/assets.
do_release_build() {
  (cd "$WT" && env -u VITE_LT_DEBUG_HOOKS -u VITE_LT_DEV_TURN_PASSWORD npm run build) &&
  ! grep -rq '__ltFriends' "$WT/dist/assets" &&
  ! grep -rq '__ltPublic' "$WT/dist/assets" &&
  ! grep -rq '__ltSecrets' "$WT/dist/assets" &&
  ! grep -rqF 'dev-turn-password' "$WT/dist/assets" &&
  release_turn_clean &&
  forbidden_literals_clean_dir "$WT/dist" &&
  assert_csp "$WT/dist" &&
  (cd "$WT" && npx cap sync android) &&
  (cd "$WT/android" && ./gradlew assembleDebug --console=plain) &&
  release_apk_hooks_clean
}
# The debug APK this stage rebuilds is the artifact do_publish ships
# (review L6): assert the hooks are absent from the ARCHIVE itself,
# not just from dist/ — cap sync copies dist/assets into the APK, so
# a packaging slip would otherwise ship the hooks.
release_apk_hooks_clean() {
  local tmp
  tmp=$(mktemp -d)
  unzip -qo "$WT/$APK_REL" -d "$tmp" || { rm -rf "$tmp"; return 1; }
  hooks_absent_dir "$tmp" || { rm -rf "$tmp"; return 1; }
  rm -rf "$tmp"
}
# The rotated dev TURN password must not ship either. The pattern is
# read from the ops password file (grep -f), so the value itself never
# appears on a command line or in a log. S27: a missing or empty
# password file FAILS CLOSED — the old guard returned 0 when the file
# was absent, silently skipping the only rotated-password check on
# dist/assets. If the file is gone, nothing ships unverified.
release_turn_clean() {
  if [ ! -s "$STATE/dev-turn-password" ]; then
    ci_say "release_turn_clean: dev-turn-password missing or empty at $STATE/dev-turn-password; refusing to ship an unverified bundle"
    return 1
  fi
  ! grep -rqF -f "$STATE/dev-turn-password" "$WT/dist/assets"
}
# Forbidden literals must never ship in the bundle or the release
# archives. The patterns are the single ops-side file
# $STATE/privacy-secrets (0600, one literal per line, no blank
# lines -- an empty pattern matches everything), shared with the
# secret-scan stage: dev-box hostname, burned TURN credential,
# testnet password, and three internal paths. They are read with
# grep -f, so the values never appear in the repo, on a command
# line, or in a log. A missing or empty file fails closed: the check
# cannot run, so nothing ships. See ci/README.md.
forbidden_literals_clean_dir() { # dir
  if [ ! -s "$STATE/privacy-secrets" ]; then
    ci_say "privacy-secrets: pattern file missing or empty at $STATE/privacy-secrets; refusing to ship an unverified bundle"
    return 1
  fi
  [ -d "$1" ] || { ci_say "privacy-secrets: directory missing: $1"; return 1; }
  ! grep -riqF -f "$STATE/privacy-secrets" "$1"
}
# The release APK/AAB carry the same web bundle cap sync copied from
# dist/assets; verify the shipped archives themselves, not just dist.
# Extracted to a temp dir and grepped as files (never piped into
# grep -q -- see the aapt2 SIGPIPE note in do_signed_release).
release_artifacts_clean() {
  local tmp
  tmp=$(mktemp -d)
  unzip -qo "$WT/$RELEASE_APK_REL" -d "$tmp/apk" || { rm -rf "$tmp"; return 1; }
  unzip -qo "$WT/$RELEASE_AAB_REL" -d "$tmp/aab" || { rm -rf "$tmp"; return 1; }
  if forbidden_literals_clean_dir "$tmp/apk" && forbidden_literals_clean_dir "$tmp/aab" && hooks_absent_dir "$tmp/apk" && hooks_absent_dir "$tmp/aab"; then
    rm -rf "$tmp"
    return 0
  fi
  rm -rf "$tmp"
  return 1
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
# Rel L8 — proof retries are split from full-run retries. A failed proof
# used to fail the run, and lt_main_loop's next trigger then re-ran the
# WHOLE pipeline for the same commit (~15 min: checkout, npm ci, both
# builds, provision, every proof) — even though the fleet was still up
# and the APK already built. Now each proof stage retries in place
# (retry_proof, once by default) against the same provisioned fleet and
# the same APK: a proof failure costs one more proof run (minutes), not
# a full re-run. This is NOT a second chance for the app — the proof
# must still pass in full on some attempt, assertions untouched — it
# only stops an infrastructure transient from discarding a whole green
# run. LT_PIPELINE_PROOF_RETRIES tunes the count; 0 restores the old
# fail-fast behavior. Non-proof stages never retry here: a build/test
# failure still fails the run, and the next trigger re-runs the
# pipeline (that retry is for real breakage, not flakes). The
# lt_main_loop full-run retry stays as the backstop.
PIPELINE_PROOF_RETRIES="${LT_PIPELINE_PROOF_RETRIES:-1}"
case "$PIPELINE_PROOF_RETRIES" in ''|*[!0-9]*) PIPELINE_PROOF_RETRIES=1 ;; esac
retry_proof() { # label, command... — run; on failure retry in place
  local label=$1; shift
  local attempt=1 rc=0
  while :; do
    "$@"
    rc=$?
    if [ "$rc" = "0" ]; then return 0; fi
    if [ "$attempt" -gt "$PIPELINE_PROOF_RETRIES" ]; then return "$rc"; fi
    ci_say "proof $label failed — pipeline-level retry $attempt/$PIPELINE_PROOF_RETRIES, same fleet, same APK (Rel L8)"
    attempt=$((attempt + 1))
  done
}
do_e2e()       { retry_proof e2e-gate "$REPO/e2e/run-e2e.sh" "$WT/$APK_REL"; }
do_migration() { (cd "$REPO/e2e" && retry_proof migration-proof env APK="$WT/$APK_REL" node proof-migration.mjs); }
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
do_proof() { # proof-name — retried in place on failure (Rel L8, see retry_proof)
  retry_proof "$1" env APK="$WT/$APK_REL" LT_FLEET_NO_LOCK=1 "$REPO/e2e/run-fleet.sh" run "$1"
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
# untagged. A release is cut by tagging the commit with a SIGNED tag
# (`git tag -s`, verified against the pinned operator key by the
# tag-verify stage earlier in the run) and pushing commit + tag
# together — or tagging an already-processed commit, which the tag
# path unit + lt_main_loop tag tracking now re-runs for the tag.
# The pristine worktree then sees the tag and the stage runs. Any
# failure here fails the run and nothing publishes.
# Verification is all-or-nothing: apksigner verify (v1+v2+v3),
# bundletool manifest dump (package + git-derived versionCode and
# versionName), and aapt2 badging of the release APK against the same
# expected values, plus a privacy-secrets scan of the extracted
# AAB/APK.

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
  release_artifacts_clean || return 1
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
  # Scan the generated release notes with the same privacy patterns
  # before publishing, with the PINNED scanner (H3). The secret-scan
  # stage already scanned the commit subjects before any build (S25),
  # so this is defense in depth on the generated notes themselves. A
  # hit (or a missing scanner/secrets file) fails the stage; nothing is
  # published. Hits on lines quoting a commit whose message hit is
  # already recorded in the ops history-scan baseline (message_hits)
  # are known-benign and filtered out by exact (rev, line, class)
  # match — without this, the next tagged run would fail here on the
  # known e99e089 residue (its subject names the dev-box hostname and
  # is quoted in every release-notes range since v0.2.2). A hit on any
  # other line (headers, checksums, or a subject with no baselined
  # hit) stays unknown and fails the stage (fail closed).
  pinned_scanner_check || { rm -f "$notes"; return 1; }
  local notes_rc=0 notes_scan_out="$notes.scan-out" notes_rawhits="$notes.rawhits" notes_unknown="$notes.unknown"
  "$PINNED_SCANNER_DIR/privacy-scan.sh" --secrets "$STATE/privacy-secrets" "$notes" > "$notes_scan_out" 2>&1 || notes_rc=$?
  if [ "$notes_rc" = 2 ]; then rm -f "$notes" "$notes_scan_out" "$notes_rawhits" "$notes_unknown"; return 1; fi
  if [ "$notes_rc" = 1 ]; then
    grep -F "$notes:" "$notes_scan_out" | sed "s|^$notes:||" > "$notes_rawhits" || true
    if [ ! -s "$notes_rawhits" ]; then
      ci_say "github-release: scanner reported hits but none could be mapped (unexpected output format); failing closed"
      rm -f "$notes" "$notes_scan_out" "$notes_rawhits" "$notes_unknown"
      return 1
    fi
    python3 - "$STATE/history-scan-baseline.json" "$notes" "$notes_rawhits" "$WT" > "$notes_unknown" <<'PYEOF'
import json, re, subprocess, sys
baseline_path, notes_path, rawhits_path, repo = sys.argv[1:5]
try:
    known = set(json.load(open(baseline_path)).get("message_hits", []))
except Exception as e:
    print(f"filter: baseline unreadable ({baseline_path}): {e}; filtering nothing", file=sys.stderr)
    known = set()
lines = open(notes_path).read().split("\n")
out = []
for raw in open(rawhits_path):
    raw = raw.strip()
    if not raw:
        continue
    num, _, cls = raw.rpartition(":")
    lineno = int(num)
    line = lines[lineno - 1] if 0 < lineno <= len(lines) else ""
    # Notes lines quote commits as "- <subject> (<short-hash>)"; the
    # subject is message line 1, so the candidate baseline key is
    # "<rev12>:1:<class>". No trailing hash (headers, checksums) or an
    # unresolvable hash stays unknown — fail closed.
    m = re.search(r"\(([0-9a-f]{7,40})\)\s*$", line)
    if not m:
        out.append(f"notes:{lineno}:{cls}")
        continue
    try:
        full = subprocess.check_output(
            ["git", "-C", repo, "rev-parse", m.group(1) + "^{commit}"], text=True
        ).strip()
    except Exception:
        out.append(f"notes:{lineno}:{cls}")
        continue
    if f"{full[:12]}:1:{cls}" not in known:
        out.append(f"notes:{lineno}:{cls}")
if out:
    print("\n".join(sorted(set(out))))
PYEOF
    if [ -s "$notes_unknown" ]; then
      ci_say "github-release: unknown release-notes hits (not in the history-scan baseline):"
      sed 's/^/github-release:   /' "$notes_unknown"
      rm -f "$notes" "$notes_scan_out" "$notes_rawhits" "$notes_unknown"
      return 1
    fi
    ci_say "github-release: release-notes hits all known (history-scan baseline)"
  fi
  rm -f "$notes_scan_out" "$notes_rawhits" "$notes_unknown"
  gh release create "$tag" --repo "$repo" --title "Longtable $tag" --notes-file "$notes" \
    "$PUBLISH_RELEASE_APK" "$PUBLISH_AAB" "$PUBLISH_RELEASE_APK.sha256" "$PUBLISH_AAB.sha256" || { rm -f "$notes"; return 1; }
  rm -f "$notes"
  ci_say "github-release: published https://github.com/$repo/releases/tag/$tag"
  GITHUB_RELEASE=published
}

# Post-publish verification: re-download the GitHub Release assets and
# check them against the sidecars. Nothing here re-proves the build —
# the artifacts were already verified before publish — it proves the
# PUBLISH: that what GitHub serves is byte-identical to what this run
# published (no truncated upload, no swapped asset, no stale sidecar).
# Runs ONLY when this run published a GitHub release; otherwise skips
# cleanly. Each downloaded asset is checked twice (digests only in the
# log): against its downloaded .sha256 sidecar, and against the local
# published file. A download failure is retried (GitHub can lag the
# create call by seconds); a checksum mismatch fails the stage loudly
# — the release is already public at that point, so the failure is
# recorded in status.json for the operator, not silently absorbed.
do_post_publish_verify() {
  local tag repo tmp attempt
  if [ "$GITHUB_RELEASE" != published ]; then
    ci_say "post-publish-verify: no GitHub release this run (github_release=$GITHUB_RELEASE); skipping"
    return 0
  fi
  tag=$(git -C "$WT" describe --tags --exact-match HEAD 2>/dev/null || true)
  [ -n "$tag" ] || { ci_say "post-publish-verify: github_release=published but HEAD has no exact tag; refusing"; return 1; }
  command -v gh >/dev/null 2>&1 || { ci_say "post-publish-verify: gh CLI not found"; return 1; }
  repo=$(gh_repo_for "$WT")
  [ -n "$repo" ] || { ci_say "post-publish-verify: could not derive owner/repo from origin"; return 1; }
  tmp=$(mktemp -d)
  for attempt in 1 2 3; do
    if gh release download "$tag" --repo "$repo" --dir "$tmp" >"$tmp/download.log" 2>&1; then
      break
    fi
    if [ "$attempt" = 3 ]; then
      ci_say "post-publish-verify: download failed after 3 attempts (see $tmp/download.log)"
      rm -rf "$tmp"; return 1
    fi
    ci_say "post-publish-verify: download attempt $attempt failed; retrying in 20s"
    sleep 20
  done
  local asset sidecar local_file dl_sha side_sha local_sha
  for asset in longtable-release.aab longtable-release.apk; do
    sidecar="$asset.sha256"
    [ -f "$tmp/$asset" ] || { ci_say "post-publish-verify: downloaded $asset missing"; rm -rf "$tmp"; return 1; }
    [ -f "$tmp/$sidecar" ] || { ci_say "post-publish-verify: downloaded sidecar $sidecar missing"; rm -rf "$tmp"; return 1; }
    dl_sha=$(sha256sum "$tmp/$asset" | cut -d' ' -f1)
    side_sha=$(awk '{print $1}' "$tmp/$sidecar")
    if [ "$dl_sha" != "$side_sha" ]; then
      ci_say "post-publish-verify: downloaded $asset does not match its sidecar $sidecar"
      rm -rf "$tmp"; return 1
    fi
    case "$asset" in
      longtable-release.aab) local_file="$PUBLISH_AAB" ;;
      longtable-release.apk) local_file="$PUBLISH_RELEASE_APK" ;;
    esac
    local_sha=$(sha256sum "$local_file" | cut -d' ' -f1)
    if [ "$dl_sha" != "$local_sha" ]; then
      ci_say "post-publish-verify: downloaded $asset differs from the published file"
      rm -rf "$tmp"; return 1
    fi
    ci_say "post-publish-verify: $asset ok (sha256 $dl_sha)"
  done
  if [ -f "$tmp/longtable-release-mapping.txt" ]; then
    dl_sha=$(sha256sum "$tmp/longtable-release-mapping.txt" | cut -d' ' -f1)
    side_sha=$(awk '{print $1}' "$tmp/longtable-release-mapping.txt.sha256")
    [ "$dl_sha" = "$side_sha" ] || { ci_say "post-publish-verify: downloaded mapping does not match its sidecar"; rm -rf "$tmp"; return 1; }
    ci_say "post-publish-verify: longtable-release-mapping.txt ok (sha256 $dl_sha)"
  fi
  rm -rf "$tmp"
  ci_say "post-publish-verify: GitHub assets match the published files + sidecars for $tag"
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
  ci_reset_run_state; APK_MD5=""; AAB_MD5=""; RELEASE_APK_MD5=""; SIGNED_RELEASE="none"; GITHUB_RELEASE="none"; FLEET_UP=""; CI_EXTRA_JSON=""; VERSION_CODE=""
  local t0=$SECONDS
  ci_say "run $run_id commit $TARGET_HASH"
  {
    ci_say "run $run_id commit $TARGET_HASH (full log: $log)"
    ci_stage checkout        do_checkout  &&
    ci_stage secret-scan     do_secret_scan &&
    ci_stage legacy-hub-digests do_legacy_digests &&
    ci_stage version-guard   do_version_guard &&
    ci_stage tag-verify      do_tag_verify &&
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
    ci_stage proof-manual-sdp do_proof proof-manual-sdp &&
    ci_stage proof-public    do_proof proof-public &&
    ci_stage proof-thirdparty do_proof proof-thirdparty &&
    ci_stage proof-importer  do_proof proof-importer &&
    ci_stage proof-localapi  do_proof proof-localapi &&
    ci_stage proof-hubfail   do_proof proof-hubfail &&
    ci_stage release-build   do_release_build &&
    ci_stage signed-release  do_signed_release &&
    ci_stage publish         do_publish &&
    ci_stage github-release  do_github_release &&
    ci_stage post-publish-verify do_post_publish_verify
    true
  } >>"$log" 2>&1
  if [ -n "$FLEET_UP" ]; then
    { ci_run_teardown fleet-teardown do_fleet_teardown; } >>"$log" 2>&1
  fi
  finished=$(date -Iseconds)
  if [ -n "$CI_FAILED_STAGE" ]; then result=failed; else result=success; fi
  CI_EXTRA_JSON=$(printf '{"apk_md5": %s, "aab_md5": %s, "release_apk_md5": %s, "signed_release": %s, "github_release": %s, "version_code": %s}' "$(ci_json_str "$APK_MD5")" "$(ci_json_str "$AAB_MD5")" "$(ci_json_str "$RELEASE_APK_MD5")" "$(ci_json_str "$SIGNED_RELEASE")" "$(ci_json_str "$GITHUB_RELEASE")" "$(ci_json_str "$VERSION_CODE")")
  ci_write_status "$result" "$started" "$finished" "$((SECONDS-t0))" "$log"
  ci_say "run $run_id result=$result failed_stage=${CI_FAILED_STAGE:-none} duration=$((SECONDS-t0))s log=$log"
  if [ "$result" = success ]; then
    git -C "$REPO" worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"
    return 0
  else
    ci_say "failed worktree kept for inspection at $WT (wiped by next run)"
    return 1
  fi
}
# --- main loop (Longtable-local, M2): process HEAD, catch up if it moved.
# The shared lib's ci_main_loop marks a commit processed unconditionally
# after run_fn returns — a failed run was marked processed and never
# retried without a manual last-processed reset (three resets in
# Waves 2-3), and a kill mid-run forced a duplicate full run. This loop
# writes last-processed ONLY for a run that succeeded and breaks after
# a failure, so the next trigger (path unit / timer) retries the same
# commit; on success it loops to catch up if HEAD moved meanwhile.
# Residual: a kill mid-run still re-runs the whole run (no per-stage
# checkpointing); the publish stages are idempotent (atomic copies,
# github-release refuses to overwrite), so the duplicate is wasted
# time, not a double publish. The shared lib is intentionally NOT
# changed here — it serves other projects; its ci_main_loop keeps its
# old contract.
#
# Tag tracking (Wave 6C): tagging an already-processed commit used to
# never trigger a release — the loop only compared HEAD against
# last-processed, and the tag changed neither. The loop now also
# compares the sorted set of tags pointing at HEAD against
# last-processed-tags (one tag per line; a missing file means "no tags
# recorded", which is the state for every run before this change and
# for every untagged HEAD). A re-run happens when HEAD moved OR when
# the HEAD tag set is non-empty and differs from the recorded set, so
# a tag added to an already-processed commit re-runs the pipeline and
# the signed-release / github-release stages see the tag. The tag set
# is recorded ONLY on a successful run, next to last-processed, so a
# failed tagged run retries on the next trigger like a failed commit
# run. A tag DELETED from HEAD does not re-trigger (an empty tag set
# never forces a run); a second tag added to the same commit does.
# The longtable-ci-tag.path unit fires the service within seconds of
# a tag change, and the 10-minute timer is the backstop if the path
# unit ever misses one.
lt_main_loop() {
  local run_fn=$1
  local target processed branch tags_now tags_processed
  branch=${CI_BRANCH:-main}
  while :; do
    target=$(git -C "$CI_REPO" rev-parse "$branch")
    processed=$(cat "$CI_STATE_DIR/last-processed" 2>/dev/null || echo "")
    tags_now=$(git -C "$CI_REPO" tag --points-at "$target" | sort)
    tags_processed=$(cat "$CI_STATE_DIR/last-processed-tags" 2>/dev/null || echo "")
    if [ "$target" = "$processed" ] && { [ -z "$tags_now" ] || [ "$tags_now" = "$tags_processed" ]; }; then
      ci_say "$branch @ $target already processed; nothing to do"
      break
    fi
    if [ "$target" = "$processed" ]; then
      ci_say "$branch @ $target already processed but HEAD tag set changed (was: ${tags_processed:-<none>}; now: $tags_now); re-running for the tag"
    fi
    if "$run_fn" "$target"; then
      echo "$target" > "$CI_STATE_DIR/last-processed"
      if [ -n "$tags_now" ]; then
        printf '%s\n' "$tags_now" > "$CI_STATE_DIR/last-processed-tags"
      else
        : > "$CI_STATE_DIR/last-processed-tags"
      fi
    else
      ci_say "$branch @ $target run FAILED; leaving it unprocessed so the next trigger retries it"
      break
    fi
  done
}
# Test hook (Wave 6C): ci/test-tag-trigger.sh sources this file with
# LT_CI_NO_MAIN=1 to exercise lt_main_loop / do_tag_verify directly
# against a scratch repo + state dir. Production runs never set it.
if [ "${LT_CI_NO_MAIN:-}" != 1 ]; then
  lt_main_loop run_one
fi
