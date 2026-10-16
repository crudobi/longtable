#!/usr/bin/env bash
# telemetry-audit.sh — Phase 4 no-telemetry audit.
#
# Method: poll `ss` every 0.5s and record every socket owned by
#   (a) the emulator family — qemu plus `netsimd`, the emulator's
#       network daemon: guest traffic is proxied by netsimd to host
#       loopback sockets, so netsimd IS the apps' network identity on
#       the host (verified live: it holds the apps' signaling sockets),
#       and
#   (b) both packaged hubs' supervisor + child processes.
# A socket counts as OUTBOUND for its owner when its local port is
# ephemeral (>= 32768): on Linux the initiator binds an ephemeral port,
# while a service-side socket shows the well-known local port. A full
# tcpdump pcap is kept alongside for the record.
#
# Two phases:
#   BASELINE — 45s with the Longtable app FORCE-STOPPED on both
#     emulators. Whatever the guest OS does with no app running
#     (e.g. Google Play services' FCM heartbeat on the emulator image)
#     is recorded as OS baseline, not app traffic.
#   SESSION — the scripted representative session
#     (e2e/telemetry-session.mjs: cold launch, friend-channel sync of
#     an edit, a Discover/AppView search).
#
# Verdict: session app endpoints − baseline − the hubs' published
# endpoints must be EMPTY, and hub processes may only talk on
# loopback. Anything else FAILS the audit.
#
# usage: bash e2e/telemetry-audit.sh
set -uo pipefail

cd "$(dirname "$0")/.."
REPO_DIR=$PWD
ROOT=${LT_ROOT:-$(cd "$REPO_DIR/../.." && pwd)}
ADB=$ROOT/tools/android-sdk/platform-tools/adb
export LT_ROOT="$ROOT"
# The host's LAN address (hub endpoints are also expected via it); CI
# provides the real value via ci.env, the default is a documentation IP.
export LT_HOST_LAN_IP="${LT_HOST_LAN_IP:-192.0.2.10}"
OUT_DIR=/tmp/lt-telemetry-audit
mkdir -p "$OUT_DIR"
BASE_LOG="$OUT_DIR/sockets-baseline.log"
POLL_LOG="$OUT_DIR/sockets.log"
PCAP="$OUT_DIR/session.pcap"
: > "$BASE_LOG"
: > "$POLL_LOG"

QEMU_PIDS=$( { pgrep -f 'qemu-system-x86_64-headless'; pgrep -f 'emulator/netsimd'; pgrep -f 'crashpad_handler'; } | tr '\n' ' ' )
HUB_PIDS=$(python3 - <<'PYEOF'
import json
import os
pids = []
_root = os.environ.get('LT_ROOT', '')
for d in (f'{_root}/ops/longtable-hub-a', f'{_root}/ops/longtable-hub-b'):
    try:
        s = json.load(open(f'{d}/hub-status.json'))
        pids.append(str(s['pid']))
        for c in s['children'].values():
            if c.get('pid'):
                pids.append(str(c['pid']))
    except Exception as e:
        print(f'# status read failed for {d}: {e}')
print(' '.join(pids))
PYEOF
)
echo "qemu pids: $QEMU_PIDS"
echo "hub pids:  $HUB_PIDS"
if [ -z "$QEMU_PIDS" ]; then
  echo "FAIL: no emulator processes found" >&2
  exit 1
fi
PID_SET=" $QEMU_PIDS $HUB_PIDS "

poll_into() {
  local log="$1"
  ss -tnup 2>/dev/null | while read -r line; do
    for pid in $PID_SET; do
      case "$line" in
        *"pid=$pid,"*)
          echo "$line" >> "$log"
          break
          ;;
      esac
    done
  done
}

run_poller() {
  local log="$1" dur="$2"
  local end=$(( $(date +%s) + dur ))
  while [ "$(date +%s)" -lt "$end" ]; do
    poll_into "$log"
    sleep 0.5
  done
}

# --- BASELINE: app force-stopped ---------------------------------------
for s in emulator-5554 emulator-5556; do
  $ADB -s $s shell am force-stop kitchen.longtable.app >/dev/null 2>&1
done
echo "baseline: capturing 45s with the app force-stopped on both emulators…"
run_poller "$BASE_LOG" 45

# --- SESSION -------------------------------------------------------------
sudo -n tcpdump -i any -nn -w "$PCAP" >/dev/null 2>&1 &
TCPDUMP_PID=$!
run_poller "$POLL_LOG" 999999 &
POLLER_PID=$!
node e2e/telemetry-session.mjs
SESSION_RC=$?
sleep 2
kill "$POLLER_PID" 2>/dev/null
sudo -n kill "$TCPDUMP_PID" 2>/dev/null

echo "session rc=$SESSION_RC"
if [ "$SESSION_RC" -ne 0 ]; then
  echo "AUDIT INCONCLUSIVE — the scripted session itself failed" >&2
  exit 1
fi
ls -lh "$PCAP" 2>/dev/null || echo "(no pcap — tcpdump unavailable; ss poll is the evidence)"

# --- analyze --------------------------------------------------------------
python3 - "$BASE_LOG" "$POLL_LOG" "$QEMU_PIDS" "$HUB_PIDS" <<'PYEOF'
import os
import re
import sys

base_log, poll_log = sys.argv[1], sys.argv[2]
qemu_pids, hub_pids = sys.argv[3].split(), sys.argv[4].split()

# Parse one ss line -> (owner_class, remote_endpoint, is_outbound).
# Local port >= 32768 (ephemeral) means this process initiated the
# connection; a well-known local port means it is the service side.
EPHEMERAL = 32768
addr_re = re.compile(r'(\[[0-9a-fA-F:]+\]|(?:\d{1,3}\.){3}\d{1,3}):(\d+)')
pid_re = re.compile(r'pid=(\d+),')

def endpoints(path):
    app, hub = set(), set()
    for line in open(path):
        pm = pid_re.search(line)
        if not pm:
            continue
        pid = pm.group(1)
        addrs = addr_re.findall(line)
        if len(addrs) < 2:
            continue
        (lip, lport), (rip, rport) = addrs[0], addrs[1]
        if int(lport) < EPHEMERAL:
            continue  # service side (inbound), not an outbound connection
        ep = f'{rip.strip("[]")}:{rport}'
        if pid in qemu_pids:
            app.add(ep)
        elif pid in hub_pids:
            hub.add(ep)
    return app, hub

base_app, _ = endpoints(base_log)
sess_app, sess_hub = endpoints(poll_log)

EXPECTED_APP = {
    # The guest's 10.0.2.2 is the host: netsimd proxies app connections
    # to host loopback, so hub endpoints appear as 127.0.0.1:<port>.
    '127.0.0.1:4445', '127.0.0.1:4446',   # signaling A/B (wss)
    '127.0.0.1:3479', '127.0.0.1:3480',   # TURN A/B
    '127.0.0.1:3221', '127.0.0.1:3222',   # AppView TLS A/B
    '127.0.0.1:2594', '127.0.0.1:2597',   # PDS TLS A/B
    # Same endpoints via the LAN address (direct-IP hub configs).
    *{
        f"{os.environ.get('LT_HOST_LAN_IP', '192.0.2.10')}:{port}"
        for port in (4445, 4446, 3479, 3480, 3221, 3222, 2594, 2597)
    },
}

def classify(ep):
    if ep in EXPECTED_APP:
        return 'hub endpoint (expected)'
    if ep in base_app:
        return 'guest-OS baseline (present with the app stopped)'
    return 'UNEXPECTED'

print('\n=== BASELINE app-side outbound endpoints (app force-stopped) ===')
for ep in sorted(base_app):
    print(f'  {ep}')
print('\n=== SESSION app-side outbound endpoints ===')
for ep in sorted(sess_app):
    print(f'  {ep:24s} {classify(ep)}')
print('\n=== SESSION hub-process outbound endpoints ===')
for ep in sorted(sess_hub):
    loop = ep.startswith('127.0.0.1:') or ep.startswith('::1:')
    print(f'  {ep:24s} {"hub-internal (loopback)" if loop else "UNEXPECTED — non-local"}')

unexpected_app = {ep for ep in sess_app if classify(ep) == 'UNEXPECTED'}
unexpected_hub = {ep for ep in sess_hub
                  if not (ep.startswith('127.0.0.1:') or ep.startswith('::1:'))}
print(f'\napp endpoints: {len(sess_app)} (baseline {len(base_app)}), '
      f'unexpected app: {len(unexpected_app)}, unexpected hub: {len(unexpected_hub)}')
if unexpected_app or unexpected_hub:
    print('AUDIT FAIL:', sorted(unexpected_app), sorted(unexpected_hub))
    sys.exit(1)
print('AUDIT PASS — every app connection is a hub endpoint or guest-OS '
      'baseline; hub processes talk only on loopback.')
PYEOF
