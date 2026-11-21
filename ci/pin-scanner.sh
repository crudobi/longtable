#!/bin/bash
# pin-scanner.sh — (re-)pin the hash-pinned privacy scanner (H3).
#
# Copies ci/privacy-scan.sh, ci/privacy-patterns, ci/privacy-allowlist
# from a reviewed repo rev into $STATE/scanner/ and records their
# SHA-256 hashes in $STATE/scanner/sha256sums. The pipeline
# (run-pipeline.sh) and the nightly history scan verify the pin
# against that manifest before every use and refuse to run on a
# missing pin or a hash mismatch — so a commit can never weaken the
# gate that judges it: the gate's code does not come from the commit.
#
# Run by the OPERATOR, by hand, after reviewing the scanner diff —
# never by CI itself (CI must never be able to re-pin its own gate).
# The pinned files come from `git show <rev>:ci/<file>`, so the pin
# records exactly the reviewed rev even if the worktree is dirty.
#
# Usage: ci/pin-scanner.sh [--repo DIR] [--state DIR] [--rev REV]
#   --rev defaults to HEAD. Prints the pinned rev, the files, and
#   their hashes (digests only — the scanner holds no secret values).
set -euo pipefail

REPO=""
STATE=""
REV="HEAD"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo)  [ $# -ge 2 ] || { echo "pin-scanner: --repo needs a value" >&2; exit 2; }; REPO=$2; shift 2 ;;
    --state) [ $# -ge 2 ] || { echo "pin-scanner: --state needs a value" >&2; exit 2; }; STATE=$2; shift 2 ;;
    --rev)   [ $# -ge 2 ] || { echo "pin-scanner: --rev needs a value" >&2; exit 2; }; REV=$2; shift 2 ;;
    -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}"; exit 0 ;;
    --) shift; break ;;
    -*) echo "pin-scanner: unknown option $1" >&2; exit 2 ;;
    *) echo "pin-scanner: unexpected argument $1" >&2; exit 2 ;;
  esac
done

[ -n "$REPO" ] || REPO=$(git rev-parse --show-toplevel 2>/dev/null || true)
[ -n "$REPO" ] || { echo "pin-scanner: no repo given and not inside one" >&2; exit 2; }
[ -d "$REPO" ] || { echo "pin-scanner: repo not a directory: $REPO" >&2; exit 2; }
if [ -z "$STATE" ]; then
  STATE=$(cd "$REPO/../.." 2>/dev/null && pwd)/ops/longtable-ci
fi
[ -d "$STATE" ] || { echo "pin-scanner: state dir missing: $STATE" >&2; exit 2; }

FULL_REV=$(git -C "$REPO" rev-parse --verify "$REV^{commit}" 2>/dev/null) || { echo "pin-scanner: unknown revision: $REV" >&2; exit 2; }

SCANNER_DIR="$STATE/scanner"
mkdir -p "$SCANNER_DIR"
for f in privacy-scan.sh privacy-patterns privacy-allowlist; do
  git -C "$REPO" show "$FULL_REV:ci/$f" > "$SCANNER_DIR/$f" || { echo "pin-scanner: ci/$f missing at $FULL_REV" >&2; exit 2; }
done
chmod 0755 "$SCANNER_DIR/privacy-scan.sh"
chmod 0644 "$SCANNER_DIR/privacy-patterns" "$SCANNER_DIR/privacy-allowlist"
(cd "$SCANNER_DIR" && sha256sum privacy-scan.sh privacy-patterns privacy-allowlist > sha256sums)
{
  echo "rev=$FULL_REV"
  echo "pinned_at=$(date -Iseconds)"
  echo "source_repo=$REPO"
} > "$SCANNER_DIR/pinned-from.txt"
(cd "$SCANNER_DIR" && sha256sum -c sha256sums)
echo "pin-scanner: pinned $FULL_REV into $SCANNER_DIR"
