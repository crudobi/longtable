# Longtable CI (on-box, devbox)

Automated tests + build on every commit to `main`, running **entirely on
devbox**. No hosted CI: per the project's trust model, builds never
leave this box (crashproof.press and its Forgejo/Woodpecker stack are
untrusted downstream — a Woodpecker agent here would take build orders
from that server, inverting the trust flow, and its docker backend is a
poor fit for the KVM emulator + tmux tooling this pipeline drives).

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

`ci/run-pipeline.sh` (installed copy:
`/home/devbox/ops/longtable-ci/run-pipeline.sh`) builds the **committed
tree** in a pristine `git worktree` — a dirty developer checkout never
leaks into a build — and runs, in order:

1. `checkout` — worktree at the target commit
2. `npm-ci` — `npm ci`
3. `typecheck` — `tsc --noEmit`
4. `unit-tests` — `vitest run`
5. `appview-tests` — the hub AppView subpackage (`appview/`): `npm ci` +
   its own vitest suite (ingest filtering, verify-then-index rejection,
   FTS5 search, HTTP API + CORS). The service-dependent proofs
   (`e2e/proof-public.mjs`, `appview` e2e) run against the standing local
   testnet instead — they need live PLC/PDS/AppView processes and fixed
   ports, which a pristine-worktree stage cannot own.
6. `web-build` — `npm run build` (before `cap sync`, per the known gotcha)
7. `cap-sync` — `npx cap sync android`
8. `apk` — `gradlew assembleDebug` (JDK 21)
9. `fleet-provision` — `e2e/run-fleet.sh provision`: provisions +
   boots all three emulator AVDs from bare state if needed (AVD
   creation + fixture-CA trust, verified), ensures the support
   services (Appium, HTTPS fixture, signaling, TURN, ATProto testnet
   + seed, AppView, TLS proxies), and installs the new APK on every
   device.
10. `e2e-gate` — `e2e/run-e2e.sh <new apk>`
11. `migration-proof` — `e2e/proof-migration.mjs`: Phase 0 APK seeds a
   recipe, the new APK upgrades over it, data must survive. Runs on
   **every** commit — this is the test whose absence let the Phase 1
   storage swap orphan user data, and it does not get tiered away.
12. `proof-p2p`, `proof-friends`, `proof-public`, `proof-thirdparty`,
    `proof-importer`, `proof-localapi`, `proof-hubfail` — the
    multi-device oath proofs, one stage each via
    `e2e/run-fleet.sh run <proof>`, in dependency order, each with an
    app-data reset on its devices first. (`proof-thirdparty` consumes
    `proof-public`'s seeded accounts/mimic; `proof-hubfail` runs last
    because it rewrites the devices' hub configuration.)
13. `publish` — copies the APK to
    `/home/devbox/builds/longtable/longtable-debug.apk`

A run stops at the first failed stage and **does not publish**. Runs are
serialized with `flock` (the emulator is a shared resource); if commits
land during a run, the runner loops and processes the new HEAD when it
finishes. The e2e harness itself runs from the repo checkout (it is box
infrastructure with hardcoded paths); the artifact under test is always
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

All under `/home/devbox/ops/longtable-ci/`:

- `status.json` — the latest run: commit, result, per-stage results and
  durations, whether it published, the published APK md5, log path.
- `history.jsonl` — one JSON line per run, append-only.
- `logs/<timestamp>-<short-hash>.log` — full output of one run.
- `work/wt` — the build worktree. Removed after a green run; **kept
  after a red run** for inspection (wiped by the next run).

A red pipeline is therefore obvious: `status.json` shows
`"result": "failed"` and `"failed_stage"`, the published APK is
untouched, and `journalctl -u longtable-ci.service` shows the run line.

Manual development is unchanged: `npm test`, `npm run build`,
`e2e/run-e2e.sh` etc. all work by hand exactly as before.

## Install / update / disable

```bash
ci/install-ci.sh          # installs units + runner; re-run after editing ci/
sudo systemctl disable --now longtable-ci.path longtable-ci.timer   # disable
sudo systemctl enable --now longtable-ci.path longtable-ci.timer    # re-enable
```
