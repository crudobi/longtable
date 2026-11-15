# Longtable CI (on-box)

Automated tests + build on every commit to `main`. No hosted CI: the
pipeline runs on the project's own infrastructure, on the same machine
that hosts the emulator fleet it drives.

The skeleton — flock serialization, the stage runner, status/history
logging, systemd unit install, always-teardown, main loop — is the
shared CI lib at `ops/shared/ci/ci-lib.sh` (see its README);
`ci/run-pipeline.sh` holds the Longtable stages only.

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
2. `secret-scan` — privacy gate (`ci/privacy-scan.sh`): scans the
   pristine worktree for secrets, private addresses/paths, and PII.
   Generic pattern classes live in the worktree's
   `ci/privacy-patterns` (EREs, no real values); specific values live
   only in the ops-side `privacy-secrets` file (0600, read with
   `grep -f`). Benign matches are allow-listed in
   `ci/privacy-allowlist` (file-glob + ERE, matched against the
   matched text). Fails closed: a missing scanner, a missing secrets
   file, or any hit fails the run before anything builds.
3. `legacy-hub-digests` — (`ci/check-legacy-hub-digests.py`): re-derives
   the expected FNV-1a-64 digests of the pre-scrub legacy hub values
   from git history (`git show d725e40:src/hubs/hubs.ts`, the scrub
   parent) and compares them against the committed
   `LEGACY_HUB_HASHES` in `src/hubs/hubs.ts`; pins the defensive
   `LEGACY_HUB_HASHES_V0` set against the digests committed by
   440c8ac. Prints digests/match booleans only, never the values.
   Fails closed on any mismatch or an unavailable revision — this is
   the check whose absence let the 440c8ac digests (which hash
   strings that never shipped) pass the bundle gate (review C1,
   2026-11-15).
4. `npm-ci` — `npm ci`
5. `typecheck` — `tsc --noEmit`
6. `lint` — `npm run lint`
7. `unit-tests` — `vitest run`
8. `appview-tests` — the hub AppView subpackage (`appview/`): `npm ci` +
   its own vitest suite (ingest filtering, verify-then-index rejection,
   FTS5 search, HTTP API + CORS). The service-dependent proofs
   (`e2e/proof-public.mjs`, `appview` e2e) run against the standing local
   testnet instead — they need live PLC/PDS/AppView processes and fixed
   ports, which a pristine-worktree stage cannot own.
9. `web-build` — `npm run build` (before `cap sync`, per the known gotcha)
10. `cap-sync` — `npx cap sync android`
11. `apk` — `gradlew assembleDebug` (JDK 21)
12. `fleet-provision` — `e2e/run-fleet.sh provision`: provisions +
   boots all three emulator AVDs from bare state if needed (AVD
   creation + fixture-CA trust, verified), ensures the support
   services (Appium, HTTPS fixture, signaling, TURN, ATProto testnet
   + seed, AppView, TLS proxies), and installs the new APK on every
   device.
13. `e2e-gate` — `e2e/run-e2e.sh <new apk>`
14. `migration-proof` — `e2e/proof-migration.mjs`: Phase 0 APK seeds a
   recipe, the new APK upgrades over it, data must survive. Runs on
   **every** commit — this is the test whose absence let the Phase 1
   storage swap orphan user data, and it does not get tiered away.
15. `proof-p2p`, `proof-friends`, `proof-public`, `proof-thirdparty`,
    `proof-importer`, `proof-localapi`, `proof-hubfail` — the
    multi-device oath proofs, one stage each via
    `e2e/run-fleet.sh run <proof>`, in dependency order, each with an
    app-data reset on its devices first. (`proof-thirdparty` consumes
    `proof-public`'s seeded accounts/mimic; `proof-hubfail` runs last
    because it rewrites the devices' hub configuration.)
16. `release-build` — rebuilds the web bundle hooks-off (no debug
    hooks, no dev TURN password), asserts the hook strings and the
    rotated dev TURN password are absent from the bundle, and the
    literals from the shared ops-side `privacy-secrets` file are absent from all
    of `dist/` (not just `dist/assets`), re-syncs and rebuilds the
    debug APK. That artifact is what `publish` ships.
17. `signed-release` — builds `bundleRelease` + `assembleRelease`
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
18. `publish` — copies the debug APK to the published location in the
    builds dir (`longtable-debug.apk`); when the signed-release stage
    published, also copies `longtable-release.aab` +
    `longtable-release.apk` (+ `longtable-release-mapping.txt` when
    produced — currently not, `minifyEnabled false`) with `.sha256`
    sidecars. Copies are atomic (`.tmp` + rename).
19. `github-release` — creates a GitHub Release for the tag (A5)
    with the signed `longtable-release.aab` +
    `longtable-release.apk` and their `.sha256` sidecars,
    changelog from `git log` since the previous tag. The generated
    release notes are scanned with the same privacy patterns before
    `gh release create` (commit subjects are not in the source tree,
    so the `secret-scan` stage cannot see them). Runs ONLY
    when the signed-release stage published this run and SKIPS
    cleanly (recorded as `github_release: "skipped"`) on
    untagged commits — same gate as signed-release. Fails
    closed if a release for the tag already exists; never
    overwrites or deletes one.

## Ops-side files the pipeline reads

Two files in the ops CI dir (`<host root>/ops/longtable-ci/`) hold
values that must never appear in the repo; the pipeline reads them
with `grep -f`, so they never appear on a command line or in a log:

- `dev-turn-password` -- the rotated dev TURN password. The
  `release-build` stage asserts it is absent from the web bundle.
- `privacy-secrets` -- one literal per line, no blank lines (an
  empty pattern matches everything): the specific values every
  privacy gate checks for -- dev-box hostname, burned TURN
  credential, testnet password, internal paths. The `secret-scan`
  stage and the release-notes scan check the worktree, history, and
  notes against it; the `release-build` stage asserts none of them
  appears in the web bundle (`dist/` as a whole), and
  `signed-release` asserts the same for the extracted release
  AAB/APK. A missing or empty file fails the run closed -- no gate
  can run without its patterns, and nothing ships unverified.

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
was never in the repo.

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
  `skipped` / `published`), log path.
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
scans every rev in `git rev-list --all` with the same
`ci/privacy-scan.sh` patterns and allow-list.

The published history still contains pre-scrub residue (internal
paths in revs before the Oct-15 rewrite) that the rewrite did not
remove, so the scan compares against a recorded baseline
(`ops/longtable-ci/history-scan-baseline.json`, established on the
first run) and fails only on NEW hits. Status is recorded in
`ops/longtable-ci/history-scan.json` (`result`: `baseline-established`
/ `known` / `dirty`, plus `revs_scanned`, `hits`, `new_hits`, and the
per-run log path); a `dirty` result means a new hit needs human
review. The scan uses the latest scanner from the repo checkout as
its backstop against a commit that neuters the scanner in the
worktree.

## Install / update / disable

```bash
ci/install-ci.sh          # installs units + runner; re-run after editing ci/
sudo systemctl disable --now longtable-ci.path longtable-ci.timer   # disable
sudo systemctl enable --now longtable-ci.path longtable-ci.timer    # re-enable
```
