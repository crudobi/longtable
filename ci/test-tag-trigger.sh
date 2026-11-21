#!/bin/bash
# test-tag-trigger.sh — Wave 6C proof harness for the tag-timing fix
# and the signed-tag verification in ci/run-pipeline.sh.
#
# Builds a scratch repo + scratch CI state dir, sources the REAL
# run-pipeline.sh with LT_CI_NO_MAIN=1 (so its main loop does not
# run), and exercises the real lt_main_loop (with a stub run_fn that
# only logs its invocation) and the real do_tag_verify against it.
# Nothing here touches the live repo, the live CI state, or the live
# pipeline lock. The GPG keys generated here are THROWAWAY test keys
# in a temp GNUPGHOME, deleted with the scratch dir on exit — they
# are never pinned as the operator key and never leave this script.
#
# Usage: ci/test-tag-trigger.sh   (run on the box, from the repo)
# Exit 0 only when every case passes; prints PASS/FAIL per case plus
# a summary count recomputed from the cases themselves.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
SHARED_LIB=$ROOT/ops/shared/ci/ci-lib.sh

PASS_COUNT=0
FAIL_COUNT=0
pass() { PASS_COUNT=$((PASS_COUNT + 1)); echo "PASS: $1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); echo "FAIL: $1"; }

T=$(mktemp -d)
trap 'git -C "${REPO:-}" worktree remove --force "${WT:-}" >/dev/null 2>&1 || true; rm -rf "$T"' EXIT
SCRATCH_ROOT=$T/root
REPO=$SCRATCH_ROOT/code/longtable
STATE=$SCRATCH_ROOT/ops/longtable-ci
RUN_LOG=$T/runs.log
: > "$RUN_LOG"

[ -f "$SHARED_LIB" ] || { echo "test-tag-trigger: shared CI lib missing at $SHARED_LIB" >&2; exit 1; }
mkdir -p "$REPO/ci" "$STATE" "$SCRATCH_ROOT/ops/shared/ci"
cp "$HERE/run-pipeline.sh" "$REPO/ci/run-pipeline.sh"
cp "$HERE/run-pipeline.sh" "$STATE/run-pipeline.sh"
cp "$HERE/history-scan.sh" "$REPO/ci/history-scan.sh"
cp "$HERE/history-scan.sh" "$STATE/history-scan.sh"
cp "$HERE/ci-lib.sha256" "$REPO/ci/ci-lib.sha256"
cp "$SHARED_LIB" "$SCRATCH_ROOT/ops/shared/ci/ci-lib.sh"

git -C "$REPO" init -b main -q
git -C "$REPO" config user.email "w6c-test@example.invalid"
git -C "$REPO" config user.name "Wave6C Test"
git -C "$REPO" config commit.gpgsign false
echo hello > "$REPO/file.txt"
git -C "$REPO" add file.txt
git -C "$REPO" commit -qm "scratch commit one"
TARGET=$(git -C "$REPO" rev-parse HEAD)
echo "$TARGET" > "$STATE/last-processed"
# NOTE: no last-processed-tags file yet — the missing-file case is T1.

export LT_ROOT="$SCRATCH_ROOT" CI_REPO="$REPO" CI_STATE_DIR="$STATE"
export CI_BRANCH=main LT_CI_NO_MAIN=1
export LT_TAG_SIGNING_KEY="$STATE/tag-signing-key.pub"
# Source the real pipeline (drift check + lock hit the SCRATCH dirs;
# the main loop does not run because LT_CI_NO_MAIN=1).
# shellcheck disable=SC1091
. "$STATE/run-pipeline.sh"

STUB_RC=0
stub_run() {
  echo "RUN $1 tags=[$(git -C "$REPO" tag --points-at "$1" | sort | tr '\n' ' ')]" >> "$RUN_LOG"
  return "$STUB_RC"
}
run_count() { grep -c '^RUN ' "$RUN_LOG" || true; }

# --- lt_main_loop: tag timing ---------------------------------------------
# T1: HEAD processed, no tags, no last-processed-tags file -> no run.
lt_main_loop stub_run
if [ "$(run_count)" = 0 ]; then pass "T1 processed untagged HEAD does not re-run (missing tag-state file)"; else fail "T1 expected 0 runs, got $(run_count)"; fi

# T2: one tag added to the already-processed HEAD -> exactly one run,
# and the tag is recorded; a second loop call does not re-run.
git -C "$REPO" tag -a w6c-t1 -m "test tag one" "$TARGET"
lt_main_loop stub_run
if [ "$(run_count)" = 1 ] && grep -qx 'w6c-t1' "$STATE/last-processed-tags"; then pass "T2 tag on processed HEAD triggers one run and records the tag"; else fail "T2 expected 1 run + recorded w6c-t1, got $(run_count) runs, tag file: $(cat "$STATE/last-processed-tags" 2>/dev/null || echo MISSING)"; fi
lt_main_loop stub_run
if [ "$(run_count)" = 1 ]; then pass "T2b recorded tag does not re-trigger"; else fail "T2b expected still 1 run, got $(run_count)"; fi

# T3: a second tag on the same HEAD -> one more run, both recorded.
git -C "$REPO" tag -a w6c-t2 -m "test tag two" "$TARGET"
lt_main_loop stub_run
if [ "$(run_count)" = 2 ] && grep -qx 'w6c-t1' "$STATE/last-processed-tags" && grep -qx 'w6c-t2' "$STATE/last-processed-tags"; then pass "T3 second tag on same HEAD triggers one more run, both recorded"; else fail "T3 expected 2 runs + both tags recorded, got $(run_count) runs"; fi

# T4: both tags deleted -> no run (deletion never forces a re-run).
git -C "$REPO" tag -d w6c-t1 w6c-t2 >/dev/null
lt_main_loop stub_run
if [ "$(run_count)" = 2 ]; then pass "T4 tag deletion does not re-trigger"; else fail "T4 expected still 2 runs, got $(run_count)"; fi

# T5: tag present but the run FAILS -> tag not recorded, next trigger retries.
git -C "$REPO" tag -a w6c-t3 -m "test tag three" "$TARGET"
STUB_RC=1
lt_main_loop stub_run
if [ "$(run_count)" = 3 ] && ! grep -qx 'w6c-t3' "$STATE/last-processed-tags" 2>/dev/null; then pass "T5 failed tagged run leaves the tag unrecorded"; else fail "T5 expected 3 runs + w6c-t3 unrecorded, got $(run_count) runs"; fi
STUB_RC=0
lt_main_loop stub_run
if [ "$(run_count)" = 4 ] && grep -qx 'w6c-t3' "$STATE/last-processed-tags"; then pass "T5b retry after failure runs once and records the tag"; else fail "T5b expected 4 runs + w6c-t3 recorded, got $(run_count) runs"; fi
git -C "$REPO" tag -d w6c-t3 >/dev/null

# --- do_tag_verify ---------------------------------------------------------
# The verifier reads tags from the pristine worktree WT.
git -C "$REPO" worktree add --detach "$WT" "$TARGET" >/dev/null

# T6: tagged HEAD, NO pinned key configured -> fail closed.
git -C "$REPO" tag -a w6c-verify -m "unsigned test tag" "$TARGET"
rc=0; do_tag_verify >/dev/null 2>&1 || rc=$?
if [ "$rc" != 0 ]; then pass "T6 tagged HEAD with no pinned key fails closed"; else fail "T6 expected tag-verify failure with no pinned key, got rc=0"; fi
# T6b: same state, tag removed -> skip cleanly.
git -C "$REPO" tag -d w6c-verify >/dev/null
rc=0; do_tag_verify >/dev/null 2>&1 || rc=$?
if [ "$rc" = 0 ]; then pass "T6b untagged HEAD skips verification cleanly"; else fail "T6b expected tag-verify success on untagged HEAD, got rc=$rc"; fi

# T7: throwaway test key pinned; tag signed by it -> pass.
# NOTE: this SSH session has no TTY, so gpg-agent's pinentry fails
# ("Inappropriate ioctl for device") unless loopback mode is set in
# the throwaway homedir's gpg.conf and keygen passes an empty
# passphrase -- the key is unprotected by design (test-only).
export GNUPGHOME="$T/gnupg-test"
mkdir -p "$GNUPGHOME"; chmod 700 "$GNUPGHOME"
printf 'pinentry-mode loopback\n' > "$GNUPGHOME/gpg.conf"
gpg --batch --pinentry-mode loopback --passphrase '' --quick-generate-key 'Wave6C Test <w6c-test@example.invalid>' ed25519 sign never >/dev/null 2>&1
FPR=$(gpg --batch --with-colons --list-keys 'w6c-test@example.invalid' 2>/dev/null | awk -F: '/^fpr:/ {print $10; exit}')
[ -n "$FPR" ] || { fail "T7 could not generate throwaway test key"; exit 1; }
gpg --batch --armor --export "$FPR" > "$STATE/tag-signing-key.pub"
git -C "$REPO" -c user.signingkey="$FPR" tag -s w6c-signed -m "signed test tag" "$TARGET"
out=""; rc=0; out=$(do_tag_verify 2>&1) || rc=$?
if [ "$rc" = 0 ] && printf '%s\n' "$out" | grep -q "VALIDSIG\|signature valid for pinned key $FPR"; then pass "T7 tag signed by the pinned test key verifies (fingerprint $FPR)"; else fail "T7 expected tag-verify success for pinned-key signature, got rc=$rc out: $out"; fi
git -C "$REPO" tag -d w6c-signed >/dev/null

# T8: unsigned tag with a key pinned -> fail closed.
git -C "$REPO" tag -a w6c-unsigned -m "unsigned test tag" "$TARGET"
rc=0; do_tag_verify >/dev/null 2>&1 || rc=$?
if [ "$rc" != 0 ]; then pass "T8 unsigned tag fails closed with a key pinned"; else fail "T8 expected tag-verify failure for unsigned tag, got rc=0"; fi
git -C "$REPO" tag -d w6c-unsigned >/dev/null

# T9: tag signed by a DIFFERENT throwaway key -> fail closed.
export GNUPGHOME="$T/gnupg-test2"
mkdir -p "$GNUPGHOME"; chmod 700 "$GNUPGHOME"
printf 'pinentry-mode loopback\n' > "$GNUPGHOME/gpg.conf"
gpg --batch --pinentry-mode loopback --passphrase '' --quick-generate-key 'Wave6C Other <w6c-other@example.invalid>' ed25519 sign never >/dev/null 2>&1
FPR2=$(gpg --batch --with-colons --list-keys 'w6c-other@example.invalid' 2>/dev/null | awk -F: '/^fpr:/ {print $10; exit}')
[ -n "$FPR2" ] || { fail "T9 could not generate second throwaway test key"; exit 1; }
git -C "$REPO" -c user.signingkey="$FPR2" tag -s w6c-wrongkey -m "wrong-key test tag" "$TARGET"
rc=0; do_tag_verify >/dev/null 2>&1 || rc=$?
if [ "$rc" != 0 ]; then pass "T9 tag signed by a non-pinned key fails closed"; else fail "T9 expected tag-verify failure for wrong-key signature, got rc=0"; fi
git -C "$REPO" tag -d w6c-wrongkey >/dev/null

# T10: lightweight tag (no signature at all) -> fail closed.
git -C "$REPO" tag w6c-light "$TARGET"
rc=0; do_tag_verify >/dev/null 2>&1 || rc=$?
if [ "$rc" != 0 ]; then pass "T10 lightweight tag fails closed"; else fail "T10 expected tag-verify failure for lightweight tag, got rc=0"; fi
git -C "$REPO" tag -d w6c-light >/dev/null

echo "tag-trigger tests: $PASS_COUNT passed, $FAIL_COUNT failed"
[ "$FAIL_COUNT" = 0 ]
