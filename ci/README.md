# Longtable CI (on-box)

Automated tests + build on every commit to `main`. No hosted CI: the
pipeline runs on the project's own infrastructure, on the same machine
that hosts the emulator fleet it drives.

The skeleton — flock serialization, the stage runner, status/history
logging, systemd unit install, always-teardown — is the shared CI
lib at `ops/shared/ci/ci-lib.sh` (see its README);
`ci/run-pipeline.sh` holds the Longtable stages only, including its
own main loop (`lt_main_loop`): the shared lib's loop marks a commit
processed unconditionally after the run, which marked failed runs
processed (M2).

## How it triggers

- `longtable-ci.path` (systemd path unit) watches
  `.git/refs/heads/main`; any commit to `main` fires
  `longtable-ci.service` within seconds.
- `longtable-ci.timer` re-fires the service every 10 minutes as a
  fallback. The runner no-ops when `main` hasn't moved since the last
  processed commit, so the timer costs a few milliseconds when idle.
- Manual run: `sudo systemctl start longtable-ci.service`
  (or just commit something).

## What a run does

`ci/run-pipeline.sh` (installed into the ops CI dir by
`ci/install-ci.sh`) builds the **committed
tree** in a pristine `git worktree` — a dirty developer checkout never
leaks into a build — and runs, in order:

1. `checkout` — worktree at the target commit
2. `secret-scan` — privacy gate: scans the pristine worktree for
   secrets, private addresses/paths, and PII with the HASH-PINNED
   scanner (`$STATE/scanner/`, H3 — never the worktree's own `ci/`
   copy). Generic pattern classes live in the pinned
   `privacy-patterns` (EREs, no real values); specific values live
   only in the ops-side `privacy-secrets` file (0600, read with
   `grep -f`). Benign matches are allow-listed in the pinned
   `privacy-allowlist` (file-glob + ERE, matched against the
   matched literal, anchored `^...$` — never the whole line). It
   also scans commit messages and tag annotations (M18/S25): the
   message scan covers every commit the release notes will quote
   (previous-tag..HEAD — a batch push can land several commits in
   one run, and scanning HEAD only would miss a secret in an
   intermediate subject), plus the HEAD tag annotation, all BEFORE
   any build or publish. Message hits already recorded in the ops
   history-scan baseline (`message_hits`) are known-benign and
   filtered out by exact (rev, line, class) match; anything else
   fails the run, and a missing/unreadable baseline filters nothing
   (fail closed). Fails closed: a missing scanner/pin, a missing
   secrets file, or any hit fails the run before anything builds.
3. `legacy-hub-digests` — (`ci/check-legacy-hub-digests.py`): re-derives
   the expected FNV-1a-64 digests of the pre-scrub legacy hub values
   from git history (`git show d725e40:src/hubs/hubs.ts`, the scrub
   parent) and compares them against the committed
   `LEGACY_HUB_HASHES` in `src/hubs/hubs.ts`. Prints digests/match
   booleans only, never the values. (The defensive
   `LEGACY_HUB_HASHES_V0` set was pinned the same way until it was
   removed after the v0.2.2 release — the fragment strings never
   shipped, so no device needs it.) Fails closed on any mismatch or an
   unavailable revision — this is the check whose absence let the
   440c8ac digests (which hash strings that never shipped) pass the
   bundle gate (review C1, 2026-11-15).
4. `version-guard` — versionCode monotonicity: versionCode is
   `git rev-list --count HEAD`, so it is monotonic by construction
   unless history is rewritten. Compares HEAD's count against the
   most recent reachable tag; fails if HEAD's count is lower (a
   rewrite would ship a versionCode below the last tagged release,
   which Play refuses). Skips cleanly when no tag is reachable yet.
   Records the count as `version_code` in status.json.
5. `npm-ci` — `npm ci`
6. `typecheck` — `tsc --noEmit`
7. `lint` — `npm run lint`
8. `unit-tests` — `vitest run`
9. `appview-tests` — the hub AppView subpackage (`appview/`): `npm ci` +
   its own vitest suite (ingest filtering, verify-then-index rejection,
   FTS5 search, HTTP API + CORS). The service-dependent proofs
   (`e2e/proof-public.mjs`, `appview` e2e) run against the standing local
   testnet instead — they need live PLC/PDS/AppView processes and fixed
   ports, which a pristine-worktree stage cannot own.
10. `web-build` — `npm run build` (before `cap sync`, per the known gotcha)
11. `cap-sync` — `npx cap sync android`
12. `apk` — `gradlew assembleDebug` (JDK 21)
13. `fleet-provision` — `e2e/run-fleet.sh provision`: provisions +
   boots all three emulator AVDs from bare state if needed (AVD
   creation + fixture-CA trust, verified), ensures the support
   services (Appium, HTTPS fixture, signaling, TURN, ATProto testnet
   + seed, AppView, TLS proxies), and installs the new APK on every
   device.
14. `e2e-gate` — `e2e/run-e2e.sh <new apk>`
15. `migration-proof` — `e2e/proof-migration.mjs`: Phase 0 APK seeds a
   recipe, the new APK upgrades over it, data must survive. Runs on
   **every** commit — this is the test whose absence let the Phase 1
   storage swap orphan user data, and it does not get tiered away.
16. `proof-p2p`, `proof-friends`, `proof-public`, `proof-thirdparty`,
    `proof-importer`, `proof-localapi`, `proof-hubfail` — the
    multi-device oath proofs, one stage each via
    `e2e/run-fleet.sh run <proof>`, in dependency order, each with an
    app-data reset on its devices first. (`proof-thirdparty` consumes
    `proof-public`'s seeded accounts/mimic; `proof-hubfail` runs last
    because it rewrites the devices' hub configuration.)
17. `release-build` — rebuilds the web bundle hooks-off (no debug
    hooks, no dev TURN password), asserts the hook strings
    (`__ltFriends`/`__ltPublic`/`__ltSecrets`) and the rotated dev
    TURN password are absent from the bundle — the password check
    fails closed if `dev-turn-password` is missing (S27: a missing
    file used to silently skip the check) — and the literals from
    the shared ops-side `privacy-secrets` file are absent from all
    of `dist/` (not just `dist/assets`), asserts the CSP survives
    into the built `index.html` (`assert_csp`, L5), re-syncs and
    rebuilds the debug APK, and asserts the hooks are absent from
    the APK itself (`release_apk_hooks_clean`, L6). That artifact
    is what `publish` ships.
18. `signed-release` — builds `bundleRelease` + `assembleRelease`
    signed with the ops-dir upload keystore (`key.properties` beside
    the keystore, never in the repo), then verifies: `apksigner
    verify`, `bundletool dump manifest` (package + git-derived
    versionCode/versionName), and `aapt2 dump badging` of the release
    APK, plus a privacy-secrets scan of the extracted AAB/APK.
    Runs ONLY when HEAD carries an exact git tag and SKIPS
    cleanly (recorded as `signed_release: "skipped"`) on untagged
    commits — the A3 fail-closed rule (release builds refuse untagged
    or dirty HEADs) is never relaxed. Tag a commit (e.g. `v0.1.0`)
    and push commit + tag together to cut a signed release.
19. `publish` — copies the debug APK to the published location in the
    builds dir (`longtable-debug.apk`); when the signed-release stage
    published, also copies `longtable-release.aab` +
    `longtable-release.apk` (+ `longtable-release-mapping.txt` when
    produced — currently not, `minifyEnabled false`) with `.sha256`
    sidecars. Copies are atomic (`.tmp` + rename).
20. `github-release` — creates a GitHub Release for the tag (A5)
    with the signed `longtable-release.aab` +
    `longtable-release.apk` and their `.sha256` sidecars,
    changelog from `git log` since the previous tag. The generated
    release notes are scanned with the pinned scanner before
    `gh release create` (defense in depth: the `secret-scan` stage
    already scanned the commit subjects before any build). Notes hits
    on lines quoting a commit whose message hit is already in the
    history-scan baseline are filtered out by exact (rev, line, class)
    match — without this the next tagged run would fail here on the
    known e99e089 residue (its subject names the dev-box hostname and
    is quoted in every notes range since v0.2.2); a hit on any other
    line fails the stage. Runs ONLY
    when the signed-release stage published this run and SKIPS
    cleanly (recorded as `github_release: "skipped"`) on
    untagged commits — same gate as signed-release. Fails
    closed if a release for the tag already exists; never
    overwrites or deletes one.
21. `post-publish-verify` — re-downloads the GitHub Release assets
    (`gh release download`, retried 3x) and checks each downloaded
    file against its downloaded `.sha256` sidecar AND against the
    local published file. Runs ONLY when this run published a GitHub
    release; skips cleanly otherwise. A mismatch fails the stage —
    the release is already public at that point, so the failure is
    recorded in status.json for the operator, not absorbed.

## Hash-pinned scanner (H3)

The pipeline never executes the scanner from the worktree it is
judging: a commit could neuter its own gate. Instead both the
per-commit secret-scan stage and the nightly history scan run the
scanner from `$STATE/scanner/`, installed by hand with
`ci/pin-scanner.sh` from a reviewed rev (`git show <rev>:ci/<file>`)
and verified against a `sha256sums` manifest before every use. A
missing pin or a hash mismatch fails the run closed.

- **Pin:** `ci/pin-scanner.sh [--repo DIR] [--state DIR] [--rev REV]`
  (defaults: current repo, `$STATE`, `HEAD`). Review the scanner
  diff first — the pin records the rev in `pinned-from.txt`.
- **Re-pin** after any change to `ci/privacy-scan.sh`,
  `ci/privacy-patterns`, or `ci/privacy-allowlist`, and after every
  merge that touches them: the merge worker verifies the pin against
  the merged scanner (hash check) and re-pins if it differs.
- The repo's `ci/` copy is only the source the operator pins FROM;
  it is never executed by the pipeline.

Scanner modes (Wave 5D): repo mode scans tracked AND untracked
non-ignored files (`git ls-files --cached --others
--exclude-standard`) — gitignored files are deliberately excluded
(they are build outputs and local secret-adjacent files: `dist/`,
`*.jks`, `.env`, `turn-password.txt`; built/published artifacts are
covered by the artifact gates instead). Single-file mode matches
file-specific allowlist entries by suffix, so an absolute target
path gets the same exemptions as a repo-relative one. A scan
without `--secrets` and without `STATE` set exits 2 (fail closed)
unless `--generic-only` is passed explicitly — a generic-patterns-only
scan is a deliberate, acknowledged reduction, not a silent default.

## Drift check + shared-lib pin (Sec L21)

The installed pipeline must track the repo: a stale installed copy
silently runs old gates (the pre-H3 installed copy ran the worktree
scanner, skipped message scans, and used the shared lib's main loop
that marked failed runs processed). `run-pipeline.sh` and
`history-scan.sh` therefore compare the installed copy against
`$REPO/ci/` (`cmp -s`) at run start — before the lock is taken —
and fail closed on drift; the operator re-runs `ci/install-ci.sh`
after any `ci/` change, before the next run can go green.

The shared CI lib (`ops/shared/ci/ci-lib.sh`) is likewise pinned:
`ci/ci-lib.sha256` holds its SHA-256, and both `run-pipeline.sh`
and `install-ci.sh` verify the hash BEFORE sourcing the lib. Update
the pin ONLY when the shared lib changes deliberately: review the
lib diff, recompute the hash, commit the new pin. A stale pin blocks
every run until updated.

## Ops-side files the pipeline reads

Two files in the ops CI dir (`<host root>/ops/longtable-ci/`) hold
values that must never appear in the repo; the pipeline reads them
with `grep -f`, so they never appear on a command line or in a log:

- `dev-turn-password` -- the rotated dev TURN password. The
  `release-build` stage asserts it is absent from the web bundle.
- `privacy-secrets` -- one literal per line, no blank lines (an
  empty pattern matches everything): the specific values every
  privacy gate checks for -- dev-box hostname, burned TURN
  credential, testnet password, internal paths, the dev TURN
  password (M21), and the CI-upload keystore passwords
  (`storePassword` + `keyPassword` from `key.properties`, M21).
  The `secret-scan` stage and the release-notes scan check the
  worktree, history, and notes against it; the `release-build`
  stage asserts none of them appears in the web bundle (`dist/`
  as a whole), and `signed-release` asserts the same for the
  extracted release AAB/APK. A missing or empty file fails the
  run closed -- no gate can run without its patterns, and nothing
  ships unverified.

Both files are mode `0600`, created once by the operator, and
are NOT managed by `ci/install-ci.sh` (install only copies
`run-pipeline.sh` and the units). If `privacy-secrets` is ever
lost, re-derive it: the hostname and burned credential from the
fragment-assembled `LEGACY_*` constants in git history (they
survive in the public history by design of the Oct-15 scrub): the
hostname is the legacy hub id minus its `-dev` suffix, the
credential is the legacy TURN credential value. The testnet
password is in the pre-rewrite backup bundle
`ops/longtable-history-backup-20261015.bundle` (box-only, never
pushed). The three internal paths are generic literals, described
here by role, not by value: the muscle store root, the operator's
home directory, and the sandbox home directory. The first two are
also in the backup bundle; the third is a defensive tripwire that
was never in the repo. The dev TURN password re-derives from
`dev-turn-password` in the same ops dir; the keystore passwords
from `key.properties` there. After rotating any of them, re-run
the append script so the new value is covered (an old value stays
in the file until the operator removes it — a leaked old value
must stay scannable).

A run stops at the first failed stage and **does not publish**. Runs are
serialized with `flock` (the emulator is a shared resource); if commits
land during a run, the runner loops and processes the new HEAD when it
finishes. The e2e harness itself runs from the repo checkout (it is box
infrastructure that derives its own paths); the artifact under test is always
the worktree-built APK.

Everything runs on every commit — no fast/full tiering. Duration is
dominated by the emulator stages (fleet provision + the proof suite);
see `history.jsonl` for measured per-stage timings.

After the stage chain — pass or fail — the runner stops the emulator
fleet (recorded as a `fleet-teardown` entry in the run's stage list; a
teardown failure is reported there but does not change the publish
outcome, which the test stages have already decided). The fleet stages
drive `e2e/run-fleet.sh` under the same flock the runner itself holds,
so a CI run and a manual fleet run can never overlap.

## Status and logs

All under the ops CI dir (`<host root>/ops/longtable-ci/`):

- `status.json` — the latest run: commit, result, per-stage results and
  durations, whether it published, the published APK md5, the signed
  AAB / release APK md5s and `signed_release` state (`none` /
  `skipped` / `published`), plus `github_release` state (`none` /
  `skipped` / `published`) and the `version_code` recorded by the
  version-guard stage, log path.
- `history.jsonl` — one JSON line per run, append-only.
- `history-scan.json` — the latest nightly all-history scan (see
  above); `history-scan-baseline.json` — the recorded known-hit set
  it compares against.
- `logs/<timestamp>-<short-hash>.log` — full output of one run.
- `work/wt` — the build worktree. Removed after a green run; **kept
  after a red run** for inspection (wiped by the next run).

A red pipeline is therefore obvious: `status.json` shows
`"result": "failed"` and `"failed_stage"`, the published APK is
untouched, and `journalctl -u longtable-ci.service` shows the run line.

Manual development is unchanged: `npm test`, `npm run build`,
`e2e/run-e2e.sh` etc. all work by hand exactly as before.

## Nightly history scan

The per-commit `secret-scan` stage only sees HEAD, so a secret
committed and reverted before HEAD would never trip it -- but the
reverted commit is still public on GitHub. `ci/history-scan.sh`
closes that case: every night at 03:17
(`longtable-history-scan.timer`, installed by `ci/install-ci.sh`)
it fetches origin into a mirror under `ops/longtable-ci/work/` and
scans every rev in `git rev-list --all` with the hash-pinned
scanner (`$STATE/scanner/`, H3 — never the repo's own `ci/` copy),
plus every commit message and tag annotation (M18). The tree scan
runs the fixed-literal secrets pass over binary blobs too
(`git grep -l -F`, no `-I`): a secret literal embedded in a binary
file is reported as `file:0:secret-binary`. Generic ERE patterns are
NOT run on binary blobs — they are noise-prone on binary bytes, and
a fixed secrets literal cannot match by chance — so a binary blob
could still hide a generic-pattern-shaped value (a private-key
header, a token prefix); that residual is accepted and documented
here, not silently assumed away.

The published history still contains pre-scrub residue (internal
paths in revs before the Oct-15 rewrite) that the rewrite did not
remove, so the scan compares against a recorded baseline
(`ops/longtable-ci/history-scan-baseline.json`, established on the
first run) and fails only on NEW hits. Status is recorded in
`ops/longtable-ci/history-scan.json` (`result`: `baseline-established`
/ `known` / `dirty`, plus `revs_scanned`, `hits`, `message_hits`,
`new_hits`, `new_message_hits`, and the per-run log path); a `dirty`
result means a new hit needs human review. The pinned scanner is
the backstop against a commit that neuters the scanner in the
worktree — the scan never executes the repo's own `ci/` copy.

## Install / update / disable

```bash
ci/install-ci.sh          # installs units + runner; re-run after editing ci/
sudo systemctl disable --now longtable-ci.path longtable-ci.timer   # disable
sudo systemctl enable --now longtable-ci.path longtable-ci.timer    # re-enable
```
