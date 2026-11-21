#!/bin/bash
# install-ci.sh — install/update the Longtable on-box CI pipeline.
# Run as crudobi (uses sudo for the systemd units). Re-run after editing
# anything in ci/: the service executes the installed copy of
# run-pipeline.sh, not the working-tree file.
# Unit installation rides the shared CI lib (ci_install_units):
# templates carry @CI_ROOT@, rendered at install time, so the repo
# carries no host-specific absolute paths.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
STATE=${LT_CI_STATE:-$ROOT/ops/longtable-ci}

mkdir -p "$STATE/logs" "$STATE/work"
install -m 0755 "$HERE/run-pipeline.sh" "$STATE/run-pipeline.sh"
install -m 0755 "$HERE/history-scan.sh" "$STATE/history-scan.sh"

CI_LIB=$ROOT/ops/shared/ci/ci-lib.sh
[ -f "$CI_LIB" ] || { echo "install-ci.sh: shared CI lib missing at $CI_LIB" >&2; exit 1; }
# Sec L21: verify the shared lib against the repo pin (ci/ci-lib.sha256)
# BEFORE sourcing it — a drifted lib must be reviewed + re-pinned,
# never silently executed.
CI_LIB_PIN=$HERE/ci-lib.sha256
[ -f "$CI_LIB_PIN" ] || { echo "install-ci.sh: shared CI lib pin missing at $CI_LIB_PIN" >&2; exit 1; }
CI_LIB_PIN_HASH=$(grep -v '^[[:space:]]*#' "$CI_LIB_PIN" | awk '{print $1}' | head -1)
[ -n "$CI_LIB_PIN_HASH" ] || { echo "install-ci.sh: shared CI lib pin empty at $CI_LIB_PIN" >&2; exit 1; }
[ "$(sha256sum "$CI_LIB" | cut -d' ' -f1)" = "$CI_LIB_PIN_HASH" ] || { echo "install-ci.sh: shared CI lib hash mismatch: $CI_LIB differs from the pin in $CI_LIB_PIN — review the lib diff and re-pin" >&2; exit 1; }
. "$CI_LIB"
ci_install_units "$HERE" "$STATE" "$ROOT" longtable-ci.service longtable-ci.path longtable-ci.timer longtable-history-scan.service longtable-history-scan.timer

echo "Longtable CI installed."
echo "  trigger : commit to main (path unit) + 10-min fallback timer"
echo "  history : nightly all-history privacy scan (03:17 timer)"
echo "  status  : cat $STATE/status.json"
echo "  logs    : $STATE/logs/"
echo "  disable : sudo systemctl disable --now longtable-ci.path longtable-ci.timer"
