#!/bin/bash
# install-ci.sh — install/update the Longtable on-box CI pipeline.
# Run as crudobi (uses sudo for the systemd units). Re-run after editing
# anything in ci/: the service executes the installed copy of
# run-pipeline.sh, not the working-tree file.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
STATE=/home/devbox/ops/longtable-ci

mkdir -p "$STATE/logs" "$STATE/work"
install -m 0755 "$HERE/run-pipeline.sh" "$STATE/run-pipeline.sh"

sudo install -m 0644 "$HERE/longtable-ci.service" /etc/systemd/system/longtable-ci.service
sudo install -m 0644 "$HERE/longtable-ci.path" /etc/systemd/system/longtable-ci.path
sudo install -m 0644 "$HERE/longtable-ci.timer" /etc/systemd/system/longtable-ci.timer
sudo systemctl daemon-reload
sudo systemctl enable --now longtable-ci.path longtable-ci.timer

echo "Longtable CI installed."
echo "  trigger : commit to main (path unit) + 10-min fallback timer"
echo "  status  : cat $STATE/status.json"
echo "  logs    : $STATE/logs/"
echo "  disable : sudo systemctl disable --now longtable-ci.path longtable-ci.timer"
