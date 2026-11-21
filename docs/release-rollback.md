# Release rollback — staged rollout + halt procedure

The minimum rollback brake for a production release (production
blocker #6): a written staged-rollout + halt procedure. There is no
in-app update check, kill switch, or forced update in Longtable — that
mechanism is the larger design decision and is NOT this procedure.
Until it exists, the brake below is entirely operator-side: the
rollout is staged, a bad build is halted before it reaches everyone,
and "roll back" means shipping a fixed build forward, never a
downgrade.

## What "roll back" means here

Android forbids downgrades: a device cannot install a build with a
lower `versionCode` than the one it has (`versionCode` is git-derived
and monotonic — `git rev-list --count HEAD`). So there is no rollback
to a previous build, on any channel. The only rollback is **roll
forward**: halt the bad rollout, then ship a fixed build with a higher
`versionCode` and roll it out staged the same way. Uninstalling to
escape a bad build wipes the app's local data — the user loses
everything unless they hold an encrypted backup file (`.ltbackup`,
see [backup.md](backup.md)); reinstalling and restoring from that
backup is the only path back.

## Google Play — staged rollout + halt

Play releases are uploaded by hand in the Play Console; there is no
Play upload step in the CI pipeline (`ci/run-pipeline.sh` publishes
GitHub releases only). Every Play release goes out staged:

1. **Stage 1 — 10%.** Upload the AAB to the Play Console, create the
   release, set the rollout to 10%. Wait at least 48 hours with no new
   fatal crash cluster, no data-loss report, and no broken core flow
   (launch, cookbook CRUD, pairing, publish, Discover) before
   advancing.
2. **Stage 2 — 25%, then 50%.** Same soak and the same checks at each
   step; at least 24 hours per stage.
3. **Stage 3 — 100%.** Only after the 50% stage has soaked clean.

**Halt — who, when, how.** Anyone on the release crew can halt; the
maintainer decides. Halt immediately on: a new fatal crash affecting
the launch or cookbook path; any report of data loss or recipe
corruption; pairing, publishing, or Discover broken on real devices;
or a privacy-gate failure in the shipped build. To halt: Play Console
→ the app → Release → the staged release → **Halt rollout**. Halting
stops the rollout at its current percentage — users who already have
the bad build keep it until the fix ships. Do not delete the release;
a halted release is the record of what went out and to how many.

**After a halt.** Fix forward: land the fix on `main`, confirm CI
green, tag the fix release (a new tag, a higher `versionCode`), and
put the fixed AAB through the same staged rollout from 10%. Tell
affected users what the bad build did and what the fix build changes —
in the release notes, not just in the code. If the bad build caused
data loss, say so plainly and point at the backup/restore flow; do not
minimize it.

## GitHub releases — supersede, never overwrite

GitHub releases are built and published by the CI pipeline
(`ci/run-pipeline.sh`: signed-release → github-release) and are
immutable: the pipeline refuses to overwrite an existing release for
a tag. A bad GitHub release is never edited or deleted in place.
Supersede it: fix on `main`, tag the fix, let the pipeline publish
the new release. Users on the bad APK install the new APK over it
(same signing key, higher `versionCode`); no data is lost by the
upgrade itself. The bad release stays up with a note pointing at the
superseding release, so nobody installs it fresh by mistake.

## What the pipeline already gates (pre-release, not rollback)

These reduce the chance a bad build ships, but none of them is a
rollback: typecheck → unit tests → AppView tests → web build → APK →
e2e gate → migration proof → publish, all `&&`-chained, a red run
publishes nothing; signed artifacts verified against the upload-key
fingerprint; privacy scan + history scan on every run; duplicate
publishes refused. If any gate goes red after a tag, the release does
not go out — that is the pre-release brake, and it is separate from
the staged-rollout brake above.

## What does not exist yet (explicitly out of scope here)

- No in-app update check, kill switch, or forced update. A bad build
  already on a device cannot be pulled back or disabled from the app
  side; the user must install the fix build.
- No staged rollout on the GitHub channel (APK installs are manual;
  the supersede-and-note step above is the whole brake there).
- No automatic crash reporting or telemetry (by design — see the
  network policy in the README), so halt decisions depend on user
  reports and the crew's own device checks, not on a dashboard.
