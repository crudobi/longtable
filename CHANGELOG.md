# Changelog

All notable changes to Longtable, newest first. Versions are git tags;
`versionCode` is derived from the commit count (`git rev-list --count
HEAD`), so every commit is a new versionCode and releases are just
tagged points on `main`. No release is cut by editing this file — see
[ci/README.md](ci/README.md) for the pipeline.

## [Unreleased]

Work on `main` since v0.2.2 (2026-11-15), under the fix-everything
program authorized 2026-11-20 ("Fix everything even nits"). Head
`b0ff535`, CI green 26/26. No tag, no release, no version bump —
release is a separate decision.

- **Wave 0** (`ea41f9a`): privacy-scan hole closed — secrets are matched
  by literal, not by whole line, so an allow-listed string on the same
  line can no longer mask a secret; dead allow-list entry removed;
  allow-list regexes anchored.
- **Wave 1** (`6ae1a3e`, `9af7dc0`, `7eda600`, merged `4664166` /
  `6f0506a` / `4b0e421`, fixups `01f76fb`, `3b04d3d`, `a38c27d`):
  AppView reconcile skips sweep-delete on missing binding, plus a
  periodic sweep; pre-C2 unsigned rows backfilled or excluded from
  serving; search summaries marked "Unverified — open to verify"; media
  fetch timeout; ingest reconciles through the queue; fractional
  minutes rounded; bad shelf manifests isolated per friend; friend
  channels bound to both DIDs; share payloads validated and capped;
  signaling crash guard; hub web-server traversal fix; history scan
  fails closed on a missing baseline and on removed hits; fleet hubs
  reinstalled from the current tarball.
- **Wave 2** (`fdbddd1`): `leaveShare` — deleting a recipe or narrowing
  it to private/friends-only now leaves the P2P room for good, with a
  "Stop sharing" button doing the same; orphaned pre-fix share records
  are cleaned up on launch instead of resurrecting.
- **Wave 3** (merged `3b3e1ec`, `fe87417`, `35dcb62`, fixups `f93416b`,
  `a700fa7`): per-device pubkey bindings (a second device publishing no
  longer un-indexes the first device's recipes); the client fetches the
  pubkey binding directly from the author's PDS instead of trusting the
  AppView; export (longtable-json) + encrypted backup (`.ltbackup`,
  Argon2id + secretbox) with a tested restore flow; crown-jewel secrets
  moved from localStorage to the Android Keystore.
- **Wave 4** (`5121b5d`, `aa40613`, `6cebbb7`, `a17ca2b`, `95ce432`,
  `be64638`, merged to `b0ff535`): corrupt stores quarantined instead
  of silently wiped, and a damaged identity blocks instead of minting a
  new DID; delete/unpublish writes a signed tombstone that recalls
  friends' copies on their next sync; URL-import photos are downloaded
  and re-hosted with a CID check; imports roll back best-effort on
  mid-import failure; the localhost API requires `"confirm": true` for
  deletes and for going public, and mutating calls return
  plain-language warnings; save-a-copy resolves the author's PDS and
  hash-checks photo bytes against the CID; media purge + Content-Type
  allowlist + AppView rate limits + firehose cursor; TURN log scrub,
  quotas, deny ranges, 0600 config; hub web TLS option + security
  headers; friends-only per-friend isolation, per-recipe signed
  manifests, resumable unfriend, single-use invites, signed invite
  display names, payload hash + DID binding; pipeline last-processed
  marker written only on success, commit/tag messages scanned, dev
  TURN + keystore passwords added to privacy-secrets, CSP/hook
  assertions on built artifacts, hash-pinned scanner, S8 pairing-test
  race fixed at root cause; storage + importer hardening (index-first
  create with rollback, flush callers, schema versioning, migration
  failure tracking, importer field preservation and caps).
- **Wave 5 — documentation (this commit)**: accepted-risks record
  (Sec L4, Sec L10, Sec L6, Int L5); README list-merge claim
  corrected (per-element list merging explicitly declined);
  localhost-API "atomic" import claim corrected and the 500 row fixed
  to match the code; delete confirm now carries the tombstone wording;
  TRADEMARKs contact added; this changelog; release-rollback procedure.

## [0.2.2] — 2026-11-15

Device-signature verification (review C2 + C1 digest fix). The AppView
verifies each public recipe's device signature at ingest and serves it
for clients; the client verifies before display. Legacy hub migration
digests corrected to the values that actually shipped, with a CI check
that re-derives them from git history.

- `d16e100` appview: await sodium.ready at module top level (fix ready race)
- `dc6d2f6` appview: remove dev-box hostname from test comment (secret-scan)
- `3deca59` / `2307fe1` merge C2 client + AppView verification halves
- `6591c8f` / `3e81b21` client-side device-signature verification + tests
- `7fb9f69` AppView e2e tamper leg + proof-public contract leg, README correction
- `de161e4` AppView: verify device signatures at ingest, serve them for clients
- `bb2d67d` / `0dabdb9` C1: legacy-hub digests fixed + CI check against git history

## [0.2.1] — 2026-11-14

Privacy gates. The pipeline gains a secret-scan stage (privacy-secrets
literals + allow-list), a nightly history scan, and a notes scan;
legacy hub literals are dropped in favor of hash matching; the
signed-release SIGPIPE race is fixed.

- `f6808dc` ci: fix history-scan default state path
- `e92c34b` ci: fix privacy-scan non-repo paths so the allow-list matches
- `664420f` ci: unify ops pattern files on privacy-secrets
- `cf21995` ci: gate privacy with a secret-scan stage, notes scan, nightly history scan
- `440c8ac` privacy: drop legacy hub literals, match on hashes; gate the bundle
- `e5b9a0d` ci: fix SIGPIPE race in signed-release aapt2 check

## [0.2.0] — 2026-11-13

Capacitor 7 → 8 (targetSdk 36, minSdk 24); the pipeline moves to the
shared CI library; GitHub Release publishing lands.

- `23945f3` build: upgrade Capacitor 7 -> 8 (targetSdk 36, minSdk 24)
- `271f48f` ci: migrate pipeline to shared CI lib (B1)
- `2f19cfc` ci: GitHub Release publisher (A5)

## [0.1.0] — 2026-11-13

First tagged release. Everything built 2026-10-11 → 2026-11-13 (113
commits): the local-first cookbook (Yjs store, IndexedDB), P2P one-off
sharing over WebRTC (Phase 1), friends-only end-to-end encrypted
sharing with pairing by invite (Phase 2), public DID-signed publishing
through ATProto + hub AppView (Phase 3), the single-artifact hub
(Phase 4), the localhost API for scripting (E9), the Importer API v1,
the Appium device gate and per-phase oath proofs, and the on-box CI
pipeline (typecheck → tests → web build → APK → e2e gate → migration
proof → publish).
