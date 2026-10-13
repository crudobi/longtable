# Longtable — local-first, peer-to-peer recipes

Longtable is a local-first P2P recipe-sharing app: your recipes live on your
devices, friends are the sync network, and public recipes are DID-signed
records anyone can verify. No platform account, no cloud service in the
middle, no telemetry.

What works today:

- **Cookbook** — create/edit/delete recipes with photos, fully offline.
  One Yjs document per recipe in IndexedDB.
- **Sharing** — one-off recipe rooms over WebRTC (QR/paste), with
  concurrent edits merging losslessly.
- **Friends** — pairing by invite code (device DIDs, no accounts),
  friends-only recipes end-to-end encrypted per friend, with key
  rotation on unfriend (forward-only: delivered copies stay readable —
  the app says so, in those words, where you unfriend).
- **Public publishing** — recipes marked public become signed
  `kitchen.longtable.recipe` ATProto records on your own PDS, searchable
  by name and ingredients through any hub's AppView within seconds.
- **Hubs** — rendezvous/indexing only, never trusted with content.
  One tarball, one config, one command to run one; clients keep a hub
  list and lose nothing when a hub dies or is switched.

## Core principles

- **Open source.** Every line ships under a free license — AGPLv3
  (see License below).
- **Free, non-commercial.** Funded by donations/grants, never tiers or ads.
  The design keeps hub operating cost near-zero so "free forever" is
  credible.
- **Deliberately easy to use but modular and developer-extensible.**
  Zero-setup local mode (no identity needed until you publish/share),
  clean module boundaries (storage / sync / identity / friends /
  publishing / hubs / importers), a versioned importer plugin API, and a
  documented public protocol third parties can build against.
- **Anti-centralization built into the functionality, not just policy.**
  Anyone can run a hub; clients support multiple hubs and switch with
  zero data loss; the app works hub-less; portable DIDs; public lexicon
  schemas + a documented protocol so third-party clients are first-class.

## For developers

- [docs/](docs/README.md) — the developer documentation index.
- [docs/architecture.md](docs/architecture.md) — the module map: every
  subsystem, its public interface, and its boundary rule.
- [docs/importers.md](docs/importers.md) — write an importer (Importer
  API v1); drop it in `src/importers/plugins/` and the app offers it.
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
- Android wrapper: Capacitor 7 (app id `kitchen.longtable.app`)
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

All builds run on devbox — never off the build machine.

```sh
# one-time env (per shell):
export JAVA_HOME=/home/devbox/tools/jdk-21  # Temurin 21; box JDK 17 is too old for Capacitor 7.6+
export ANDROID_HOME=/home/devbox/tools/android-sdk
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
