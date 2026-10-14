# Longtable e2e + Android debugging cheat-sheet

End-to-end validation runs on devbox against the `longtable-test` emulator
(Pixel 7, API 35, x86_64, KVM). The suite is Appium (UiAutomator2 driver) +
webdriverio: native context for install/system dialogs, WEBVIEW context for the
Capacitor UI (elements addressed by `data-testid` CSS selectors).

## Run the gate

```bash
/home/devbox/code/longtable/e2e/run-e2e.sh [/path/to.apk]
# default APK: /home/devbox/builds/longtable/longtable-debug.apk
```

What it does: boots the emulator (idempotent), starts Appium if needed, then
runs the gate suite — install+launch, UI renders, no crash, screenshot non-blank,
create recipe, persistence across force-stop, airplane-mode on, offline
create/edit/delete, airplane-mode off, final crash check. Exit 0 = all pass;
any failure prints the step name and the assertion that failed.

## emu.sh — emulator helper

`/home/devbox/tools/android-emu/emu.sh`:

| command | what it does |
|---|---|
| `boot` | start AVD headless in tmux (`longtable-emu`), wait for `sys.boot_completed`; no-op if already booted |
| `install <apk>` | `adb install -r -g` (grants runtime permissions up front) |
| `launch` | start `kitchen.longtable.app/.MainActivity` |
| `logcat [-d/-c/…]` | adb logcat passthrough |
| `screenshot [file]` | PNG screenshot (default `/tmp/lt-shot.png`) |
| `shell [cmd…]` | adb shell passthrough |
| `status` | `adb devices` + boot state |
| `kill` | stop emulator + tmux session |

Env notes: `ANDROID_AVD_HOME=/home/devbox/tools/android-sdk/avd`,
emulator runs `-no-window -no-audio -no-boot-anim -gpu swiftshader_indirect`.

`emu.sh` takes an optional `--avd NAME` selector (fleet registry:
`longtable-test`/5554, `longtable-test-2`/5556, `longtable-test-3`/5558;
default is `longtable-test`) and a `provision` subcommand for bare-metal
setup — see the fleet suite section below. `fleet.sh` (same directory)
drives all three AVDs at once: `fleet.sh {provision|boot|stop|status}`.


## Fleet suite — all devices, all proofs, one command

`e2e/run-fleet.sh` is the multi-emulator orchestrator. It takes the
fleet from bare state to a full validation and back down again:

```bash
/home/devbox/code/longtable/e2e/run-fleet.sh            # full suite
/home/devbox/code/longtable/e2e/run-fleet.sh provision  # bring-up only
/home/devbox/code/longtable/e2e/run-fleet.sh run proof-friends
/home/devbox/code/longtable/e2e/run-fleet.sh teardown   # stop emulators
```

What a full run does:

1. Takes the CI pipeline flock
   (`/home/devbox/ops/longtable-ci/pipeline.lock`) — the same
   serialization the pipeline itself uses, so manual and CI runs never
   collide on the shared emulators/Appium.
2. Provisions + boots all three AVDs via `fleet.sh`/`emu.sh`
   (idempotent; see "Provisioning" below).
3. Ensures the support services: Appium, the HTTPS fixture, signaling,
   coturn (the dev TURN), the ATProto testnet (restarted + re-seeded
   if down — its DIDs are ephemeral, and seeding refreshes
   `/home/devbox/ops/longtable-atproto/accounts.json`), the hub
   AppView, and the two TLS proxies.
4. Installs the APK under test (`$APK`, default the published build;
   CI passes the pristine-worktree build) on all three devices, then
   functionally verifies each device's networking from inside the
   app's WebView (`e2e/probe-net.mjs`: the signaling WebSocket, the
   fixture HTTPS page, and WebRTC ICE gathering must all succeed —
   this catches the failure class file-level checks cannot see: CA
   present but WiFi never associated, TLS distrusted, ICE dead).
5. Runs, in order: the e2e gate, `proof-migration`, `proof-p2p`,
   `proof-friends`, `proof-public`, `proof-thirdparty`,
   `proof-importer`, `proof-localapi`, `proof-hubfail`. Before each
   proof, the app data on that proof's devices is reset (force-stop +
   `pm clear`) so every proof starts from a known state. Order
   dependencies: `proof-thirdparty` consumes `proof-public`'s seeded
   accounts and mimic record; `proof-hubfail` runs last because it
   rewrites the devices' hub configuration.
6. Prints a per-proof summary (also written to
   `/home/devbox/ops/longtable-ci/fleet-logs/<timestamp>/summary.txt`,
   with a log per step alongside) and stops all three emulators.

Retries: emulator proofs are subject to infrastructure transients
(emulator networking stalls, WebView/Appium hiccups) that have
nothing to do with the app under test — the manual sweep process
always re-ran a failed proof before believing it. Each proof
therefore gets up to 2 attempts (`LT_FLEET_PROOF_ATTEMPTS`): a
failed attempt is followed by a guest reboot of the involved
emulators and a full state reset. A proof must still pass in full
on some attempt or the run fails and names it; a pass on attempt 2
is recorded as such in the summary, and both attempts' output is
kept in the proof's log.

Teardown policy: only the emulators are stopped — they are the
multi-GB RAM cost. Appium, signaling, TURN, the testnet, the AppView,
the TLS proxies, the HTTPS fixture, and `proof-hubfail`'s packaged
hubs are shared services and stay up. Set `LT_FLEET_KEEP_UP=1` to
skip teardown when debugging.

### Provisioning

`emu.sh --avd <name> provision` (or `fleet.sh provision --all`) is
the bare-metal path for an AVD, and is fully idempotent:

- installs `system-images;android-35;google_apis;x86_64` via
  sdkmanager if absent;
- creates the AVD via avdmanager (pixel_7 profile, fleet-standard
  partition sizes) if missing or incomplete — an `.avd` directory
  without `config.ini` counts as missing, because a dying qemu can
  leave such a skeleton behind;
- boots it;
- associates the emulator WiFi with the virtual AP (`AndroidWifi`,
  open): a fresh AVD has no saved network, `wlan0` stays down, and
  Android then gives apps no default route — every WebSocket/HTTPS/
  WebRTC call fails while adb looks perfectly healthy;
- installs the fixture CA into the user trust store (the exact
  mechanism under "URL-import fixture" below) if not already trusted,
  reboots, and verifies the CA file byte-for-byte afterwards. A
  failed verify is a hard provisioning failure, never a skip. (The
  orchestrator's `net-verify` step additionally proves trust
  functionally, from inside the app WebView.)

`fleet.sh stop` is patient on purpose: `emu kill` is a graceful
shutdown that saves the quick-boot snapshot first, so stop waits up
to 90 s before escalating (SIGTERM at 45 s, SIGKILL at 75 s).

### CI

The pipeline (`ci/run-pipeline.sh`) drives this same orchestrator
stage by stage — `fleet-provision`, then the gate + migration proof,
then one stage per proof, then `publish` — and stops the fleet after
the chain whether it passed or failed (recorded as `fleet-teardown`
in `status.json`). A red proof stage blocks the publish.

## Debugging recipes

App logs (Capacitor/WebView console goes to logcat via chromium tag):

```bash
emu.sh logcat -d | grep -iE "chromium|kitchen.longtable|FATAL"
emu.sh logcat -c   # clear before a repro run
```

Crash check:

```bash
emu.sh logcat -d | grep "FATAL EXCEPTION"
```

Screenshots / screen recording:

```bash
emu.sh screenshot /tmp/bug.png
emu.sh shell screenrecord /sdcard/bug.mp4   # Ctrl-C to stop
```

Pull the WebView's IndexedDB (Automerge docs live here):

```bash
emu.sh shell "run-as kitchen.longtable.app ls app_webview/Default/IndexedDB"
# debug builds are debuggable, so run-as works:
adb -s emulator-5554 exec-out run-as kitchen.longtable.app tar c app_webview > /tmp/webview.tar
```

Clear app data (fresh-install state):

```bash
emu.sh shell pm clear kitchen.longtable.app
```

Attach tooling to the running emulator:

```bash
adb -s emulator-5554 shell          # any adb command; only one emulator is attached
# Appium: point capabilities at http://127.0.0.1:4723 with appium:udid emulator-5554
# Chrome DevTools: Capacitor debug builds set WebContentsDebuggingEnabled,
# so chrome://inspect on a desktop Chrome sees the WebView (via adb).
```

Appium server (if you need it outside run-e2e.sh):

```bash
tmux new -s longtable-appium -d 'appium --address 127.0.0.1 --port 4723'
curl -s http://127.0.0.1:4723/status | head -c 200
```

## Toolchain versions (pinned 2026-10-11)

- Appium 3.8.0 (`/usr/local/bin/appium`), uiautomator2 driver 8.7.0
- webdriverio pinned via `e2e/package-lock.json`
- Emulator + `system-images;android-35;google_apis;x86_64` under `/home/devbox/tools/android-sdk`
- Temurin JDK 21 at `/home/devbox/tools/jdk-21` (`JAVA_HOME` for sdkmanager/avdmanager)

## Storage-migration testing (from Phase 1 on)

The harness supports upgrade testing: install APK N (seed data via the suite),
`adb install -r` APK N+1 over it, assert the recipes survive.

**Phase 0 -> Phase 1 (Automerge -> Yjs):** `e2e/proof-migration.mjs` is the
repeatable proof. It installs the Phase 0 APK (built from commit `6223a9b`,
kept at `/home/devbox/builds/longtable/longtable-phase0.apk`), seeds a
recipe with a photo through the UI, upgrades with `adb install -r`, and
asserts the recipe survives exactly once with content intact — recovered by
the one-time migration in `src/store/migrateFromAutomerge.ts`. Run it with
Appium up: `cd e2e && node proof-migration.mjs`. Env overrides: `P0_APK`,
`APK`, `SERIAL`.

## URL-import fixture (HTTPS + test CA)

The url-import positive test fetches `https://10.0.2.2:18443/recipe.html`
(served from `e2e/fixtures/` by `serve-https.py`, started automatically by
`run-e2e.sh`). Plain HTTP cannot be used: the Capacitor WebView origin is
https, and Android blocks cleartext, so a fixture must be HTTPS with a
CA the emulator trusts.

One-time setup (machine-level, NOT committed):

```bash
CERTS=/home/devbox/tools/android-emu/fixture-certs
mkdir -p $CERTS && cd $CERTS
# 1. test CA + server cert (SAN IP:10.0.2.2 = emulator's host alias)
openssl req -x509 -newkey rsa:2048 -keyout ca.key -out ca.crt -days 825 -nodes -subj "/CN=Longtable E2E Test CA"
openssl req -newkey rsa:2048 -keyout server.key -out server.csr -nodes -subj "/CN=10.0.2.2"
printf "subjectAltName=IP:10.0.2.2\n" > ext.cnf
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 825 -extfile ext.cnf
# 2. install the CA in the emulator's USER trust store (persists in userdata.img)
#    NOTE: do this for EVERY emulator AVD (longtable-test AND longtable-test-2) —
#    each AVD has its own userdata.img. Missing CA = wss:// signaling silently
#    fails (WebSocket stuck in CONNECTING), y-webrtc never discovers peers.
H=$(openssl x509 -inform PEM -subject_hash_old -in ca.crt | head -1)
adb -s emulator-5554 root
adb -s emulator-5554 shell mkdir -p /data/misc/user/0/cacerts-added
adb -s emulator-5554 push ca.crt /data/misc/user/0/cacerts-added/$H.0
adb -s emulator-5554 shell chmod 644 /data/misc/user/0/cacerts-added/$H.0
adb -s emulator-5554 reboot   # keystore reads user CAs at boot
```

The debug APK trusts user CAs via a debug-only network security config
(`android/app/src/debug/`): `<debug-overrides>` applies to debuggable builds
only, so release builds keep the platform default (system CAs).

Port 18443 was chosen because 8443 is taken by the fleet API on this box.

## Photo-attach test note

chromedriver performs no client-side file detection for `sendKeys` (that lives
in desktop Selenium clients, not in chromedriver), so `setValue(path)` on the
file input silently attaches nothing (`files.length === 0`, verified). The test
instead injects the fixture JPEG (`e2e/fixtures/photo.jpg`, 1600x1200) via
`DataTransfer` + a bubbling `change` event: everything from the input's
`onChange` onward (FileReader, canvas downscale, preview, save, detail) is the
real app pipeline. The OS file picker itself is Android UI, not app code.

## proof-friends — Phase 2 oath proof (3 emulators)

```bash
node e2e/proof-friends.mjs   # needs emulators 5554/5556/5558 + Appium + signaling + TURN
```

Oath: "Only the friends you choose can read what you share with friends."
A (5554) pairs with B (5556) and C (5558) through the Friends panel paste
flow (signed did:key handshake, mutual DID records verified), shares a
recipe friends-only with both, and B/C render the shared-with-me shelf and
open it. Stranger leg: C runs the app's real receive path
(`window.__ltFriends.attemptWithShelfBytes`) on the captured A↔B shelf-doc
bytes and decryption fails explicitly ("no key envelope addressed to me").
Unfriend leg: A unfriends C (key rotates), edits the recipe; B receives and
opens v2 while C's attempt on the new bytes fails again. 14 steps.

Emulator 3 is AVD `longtable-test-3` (port 5558). Like the others it needs
the fixture test CA in its user store
(`/data/misc/user/0/cacerts-added/4060c87e.0`, content =
`fixture-certs/ca.crt`) or wss signaling fails TLS and pairing times out.
