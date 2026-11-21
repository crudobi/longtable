# Longtable — local-first, peer-to-peer recipes

Longtable is a local-first P2P recipe-sharing app: your recipes live on your
devices, friends are the sync network, and public recipes are DID-signed
records anyone can verify. No platform account, no cloud service in the
middle, no telemetry.

## What works out of the box — and what needs a hub

Installing from GitHub gets you a local cookbook. Creating, editing,
deleting, importing, and backing up recipes all work offline, with no
account and no server. The networked features do not work out of the
box, and this release does not pretend otherwise:

- **There is no public hub.** Longtable ships no production hub, and
  none is promised. The built-in hub ("Local dev hub") points at
  developer-only endpoints — signaling `wss://10.0.2.2:4444`, TURN
  `10.0.2.2:3478`, AppView `http://localhost:3210`, PDS
  `http://localhost:2583` (see `src/hubs/hubs.ts`, `DEFAULT_HUB`) —
  and release builds ship no TURN credential for it. `10.0.2.2` is the
  Android emulator's alias for its host machine: on a real phone these
  addresses reach nothing.
- **Until you configure a hub, invite-code pairing, friend sync over
  signaling, publishing, and Discover do nothing.** There is no service
  behind those addresses on a real phone. Local cooking is unaffected,
  and pairing by hand ("Pair without a hub" in Friends) needs no
  signaling server — though across NAT it still needs a STUN/TURN
  server from a configured hub.
- **To get the networked features, run a hub or use one someone you
  trust runs.** One tarball, one config, one command — see
  [hub/README.md](hub/README.md) — then add it in the app under Hubs.
  A hub is rendezvous and indexing only: it can never read your
  recipes, and switching hubs loses nothing.

Install instructions for the GitHub release (APK, not AAB; checksum
verification; what to expect from Android) are in
[docs/install.md](docs/install.md). What data leaves the device, and
when, is in [docs/privacy-policy.md](docs/privacy-policy.md).

What works today:

- **Cookbook** — create/edit/delete recipes with photos, fully offline.
  One Yjs document per recipe in IndexedDB.
- **Sharing** — one-off recipe rooms over WebRTC (QR/paste), with
  concurrent edits merging: scalar fields merge, but list fields
  (ingredients, steps, photos) replace wholesale, so concurrent edits
  to the same list can drop one side (see `src/store/recipes.ts`,
  `replaceArray`). Per-element list merging is out of scope — see
  [docs/architecture.md](docs/architecture.md).
- **Friends** — pairing by invite code (device DIDs, no accounts),
  friends-only recipes end-to-end encrypted per friend, with key
  rotation on unfriend (forward-only: delivered copies stay readable —
  the app says so, in those words, where you unfriend).
- **Public publishing** — recipes marked public become signed
  `kitchen.longtable.recipe` ATProto records on your own PDS, searchable
  by name and ingredients through a configured hub's AppView within
  seconds. Needs a configured hub and a PDS account — see "What works
  out of the box" above.
- **Hubs** — rendezvous/indexing only, never trusted with content.
  One tarball, one config, one command to run one; clients keep a hub
  list and lose nothing when a hub dies or is switched. No public hub
  ships with the app — the built-in hub is a development placeholder
  (see above).
- **Backup & restore** — a readable recipe export (`.json`, through
  the app's own importer) and an encrypted full backup (`.ltbackup`:
  identity key, friends + pair secrets, key vault, shares, and all
  recipes under an Argon2id passphrase). Restoring replaces the
  device's state and is proven by tests; a wrong passphrase or a
  damaged file changes nothing. See
  [docs/backup.md](docs/backup.md). Android auto-backup stays off —
  the backup is an explicit file the user keeps.

## Core principles

- **Open source.** Every line ships under a free license — AGPLv3
  (see License below).
- **Free, non-commercial.** Funded by donations/grants, never tiers or ads.
  The design keeps hub operating cost near-zero so "free forever" is
  credible.
- **Deliberately easy to use but modular and developer-extensible.**
  Zero-setup local mode (cooking needs no identity and no server;
  publishing and sharing need a configured hub — see above),
  clean module boundaries (storage / sync / identity / friends /
  publishing / hubs / importers), a versioned importer plugin API, and a
  documented public protocol third parties can build against.
- **Anti-centralization built into the functionality, not just policy.**
  Anyone can run a hub; clients support multiple hubs and switch with
  zero data loss; local cooking and manual pairing work hub-less
  (invite pairing, publishing, and Discover need a configured hub);
  portable DIDs; public lexicon schemas + a documented protocol so
  third-party clients are first-class.

## For developers

- [docs/install.md](docs/install.md) — install the GitHub release on a
  phone (APK sideload + checksum verification).
- [docs/privacy-policy.md](docs/privacy-policy.md) — what data leaves
  the device, and when; the app's privacy policy.
- [docs/data-safety.md](docs/data-safety.md) — groundwork for a future
  Play data-safety declaration (not a filed declaration).
- [docs/](docs/README.md) — the developer documentation index.
- [CHANGELOG.md](CHANGELOG.md) — what changed in each release.
- [docs/architecture.md](docs/architecture.md) — the module map: every
  subsystem, its public interface, and its boundary rule.
- [docs/importers.md](docs/importers.md) — write an importer (Importer
  API v1); drop it in `src/importers/plugins/` and the app offers it.
- [docs/backup.md](docs/backup.md) — backup & restore: the
  longtable-json export and the encrypted backup (formats, restore
  semantics, what is deliberately not backed up).
- [docs/public-protocol.md](docs/public-protocol.md) — the public
  recipe protocol: lexicons, both signature schemes, the AppView API,
  and the third-party read/verify flow.
- [examples/third-party-client/](examples/third-party-client/) — a
  runnable third-party client (official ATProto libraries only).
- [examples/importers/markdown/](examples/importers/markdown/) — a
  complete importer written from the docs alone (clean-room proof),
  also shipped as a built-in drop-in plugin.

## Stack

- Vite + React + TypeScript; PWA via `vite-plugin-pwa`
- Yjs (`yjs` + `y-indexeddb` + `y-webrtc`): one doc per recipe
- Identity/crypto: libsodium (Ed25519 device keys, `did:key`)
- Public layer: ATProto (custom lexicons in `lexicons/`), hub AppView
  (Node + SQLite FTS5)
- Android wrapper: Capacitor 8 (app id `kitchen.longtable.app`)
- Tests: vitest + an Appium device gate and oath proofs in `e2e/`

## Data model

One Yjs document per recipe, persisted to IndexedDB, plus one index
document mapping the recipe list to doc URLs. Recipe schema: `title`,
`ingredients[]`, `steps[]`, optional `prepMinutes`/`cookMinutes`,
`photos[]` (data URLs), optional `visibility`
(`private` | `friends-only` | `public`), `createdAt`, `updatedAt`.
Visibility is enforced by where the bytes go — see
[docs/architecture.md](docs/architecture.md).

## Network policy

No analytics, no telemetry, no phone-home, no CDN assets — everything is
bundled, and local cooking works with the network off. The app contacts
the network only for things the user asked for: fetching a page in the
URL importer, sync/publishing via the user's configured hubs and PDS,
and discovery search. This is audited, not just asserted:
`e2e/telemetry-audit.sh` packet-captures a full session and fails on any
unexpected endpoint.

## Develop

```sh
npm install
npm run dev        # local dev server
npm test           # vitest unit tests (store + URL importer)
npm run typecheck  # tsc --noEmit
npm run build      # production build to dist/
```

## Android wrapper (Capacitor)

All builds run on a dedicated build machine.

```sh
# one-time env (per shell):
export JAVA_HOME=<path to a Temurin 21 JDK>   # JDK 21 required; JDK 17 is too old for Capacitor 8
export ANDROID_HOME=<path to the Android SDK>
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

# rebuild the wrapper from the PWA:
npm run build            # fresh production build to dist/
npx cap sync android     # copy web assets into the native project

# debug APK:
cd android && ./gradlew assembleDebug
# -> android/app/build/outputs/apk/debug/app-debug.apk
```

Notes: `npx cap init Longtable kitchen.longtable.app --web-dir=dist` was used
once to create `capacitor.config.ts`; `npx cap add android` generated
`android/`. The first `./gradlew` run downloads its distribution (Gradle
8.11.1) and the SDK Platform 35 package — run it in tmux on a flaky link.

## Release signing

Release builds are signed with the project's upload key. The keystore is
held by the maintainer and is never committed to this repo.

- Upload-key certificate SHA-256 fingerprint:
  `AD:C9:E0:62:94:C2:88:7B:A6:51:7F:9A:B7:5C:BA:C8:FB:81:42:D6:99:43:66:C0:A1:BA:54:A0:10:31:D4:E9`

- The `signed-release` pipeline stage pins this fingerprint: a release
  APK signed by any other key fails the run closed.
- Keystore backup and recovery: [docs/keystore-recovery.md](docs/keystore-recovery.md)
  (where the keystore and its backups live, how to restore and verify,
  and what total loss costs).

## Verify the no-telemetry property

With the local services up (hub, signaling, testnet), run
`e2e/telemetry-audit.sh`: it captures traffic during a defined app
session (cold launches, friend-channel sync, a Discover search) and
asserts the app contacted only the expected endpoints — configured
hubs' signaling and the active AppView.

## Project structure

The full module map is [docs/architecture.md](docs/architecture.md).
In brief:

- `src/` — React UI + app shell; domain modules in `store/`,
  `identity/`, `p2p/`, `friends/`, `public/`, `hubs/`, `importers/`
- `appview/` — the hub AppView (verify-then-index, FTS5 search, media cache)
- `hub/` — the single-artifact hub bundle (one tarball, one command)
- `signaling/`, `services/` — signaling server; local ATProto testnet
- `lexicons/` — the `kitchen.longtable.*` record schemas
- `docs/`, `examples/` — developer documentation + runnable examples
- `e2e/` — Appium device gate + the per-phase oath proofs
- `android/` — Capacitor native Android project

## Test

```sh
npx tsc --noEmit   # typecheck (also runs as part of npm run build)
npx vitest run     # unit tests (npm test)
bash e2e/run-e2e.sh  # Appium device gate (needs the emulator + Appium)
```

Every commit to `main` runs the full pipeline on the build box
(typecheck → unit tests → AppView tests → web build → APK → e2e gate →
migration proof → publish; a red run publishes nothing). The per-phase
oath proofs live in `e2e/proof-*.mjs`.

## License

Code: AGPLv3 — see `LICENSE`. The protocol, lexicons, and docs are
CC0 1.0 so anyone can implement them freely — see `LICENSE-CC0.txt`.
The full licensing map is in `LICENSING.md`; contributions are under
the DCO (`CONTRIBUTING.md`); the name is covered by `TRADEMARKS.md`.
