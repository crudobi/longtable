#!/bin/bash
# install-ci.sh — install/update the Longtable on-box CI pipeline.
# Run as crudobi (uses sudo for the systemd units). Re-run after editing
# anything in ci/: the service executes the installed copy of
# run-pipeline.sh, not the working-tree file.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
STATE=${LT_CI_STATE:-$ROOT/ops/longtable-ci}

mkdir -p "$STATE/logs" "$STATE/work"
install -m 0755 "$HERE/run-pipeline.sh" "$STATE/run-pipeline.sh"

# The units are templates: @LT_ROOT@ is substituted at install time, so
# the repo carries no host-specific absolute paths.
for unit in longtable-ci.service longtable-ci.path longtable-ci.timer; do
  sed "s|@LT_ROOT@|$ROOT|g" "$HERE/$unit" > "$STATE/.$unit.tmp"
  sudo install -m 0644 "$STATE/.$unit.tmp" "/etc/systemd/system/$unit"
  rm -f "$STATE/.$unit.tmp"
done
sudo systemctl daemon-reload
sudo systemctl enable --now longtable-ci.path longtable-ci.timer

echo "Longtable CI installed."
echo "  trigger : commit to main (path unit) + 10-min fallback timer"
echo "  status  : cat $STATE/status.json"
echo "  logs    : $STATE/logs/"
echo "  disable : sudo systemctl disable --now longtable-ci.path longtable-ci.timer"
