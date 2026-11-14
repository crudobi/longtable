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
. "$CI_LIB"
ci_install_units "$HERE" "$STATE" "$ROOT" longtable-ci.service longtable-ci.path longtable-ci.timer longtable-history-scan.service longtable-history-scan.timer

echo "Longtable CI installed."
echo "  trigger : commit to main (path unit) + 10-min fallback timer"
echo "  history : nightly all-history privacy scan (03:17 timer)"
echo "  status  : cat $STATE/status.json"
echo "  logs    : $STATE/logs/"
echo "  disable : sudo systemctl disable --now longtable-ci.path longtable-ci.timer"
