# Longtable — Phase 0: Local cookbook

Longtable is a local-first P2P recipe-sharing app: your recipes live on your
device, and you share them directly with friends — no platform account, no
cloud service in the middle. Phase 0 is the local cookbook only: **no sync,
no network**. Everything runs on-device; recipes live in Automerge documents
in IndexedDB.

## Core principles

- **Open source.** Every line ships under a free license — AGPLv3 is
  proposed (see License below), to be confirmed.
- **Free, non-commercial.** Funded by donations/grants, never tiers or ads.
  The design keeps hub operating cost near-zero so "free forever" is
  credible.
- **Deliberately easy to use but modular and developer-extensible.**
  Zero-setup local mode (no identity needed until you publish/share), module
  boundaries at storage adapter, transport adapter, identity provider and
  importers, plus a localhost API for scripting and integration.
- **Anti-centralization built into the functionality, not just policy.**
  Anyone can run a hub (single binary); clients support multiple hubs and
  hub switching with zero data loss; the app works hub-less (local-only +
  manual pairing); custom TURN servers; portable DIDs, no platform account;
  no telemetry / phone-home; public lexicon schemas and a documented sync
  protocol so third-party clients are first-class.

## Stack

- Vite + React + TypeScript
- PWA via `vite-plugin-pwa` (`generateSW`, precache everything,
  `navigateFallback: index.html`)
- Automerge: `@automerge/automerge` + `@automerge/automerge-repo` +
  `@automerge/automerge-repo-storage-indexeddb`
- Android wrapper: Capacitor 7 (app id `kitchen.longtable.app`)
- Tests: vitest

## Data model

One Automerge document per recipe, persisted to IndexedDB. A dedicated
`recipe-index` Automerge document maps the recipe list to doc URLs (its URL is
kept in `localStorage` under `longtable:recipe-index-url`).

Recipe schema: `title`, `ingredients[]`, `steps[]`, optional
`prepMinutes`/`cookMinutes`, `photos[]` (data URLs), `createdAt`, `updatedAt`.

## Network policy

The app makes **zero** network requests of its own: no CDN fonts, no
analytics, no external assets — everything is bundled. The single exception
is the URL importer (`src/importers/urlImport.ts`, the app's only `fetch()`),
which is strictly user-initiated and clearly labeled in the UI.

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

## Verify the zero-network property

```sh
npm run build
cd dist && python3 ../tools/lt-server.py   # logging server on :8765
# terminal 2: first load — creates a recipe via the UI, installs the SW
env -u DBUS_SESSION_BUS_ADDRESS -u DBUS_SYSTEM_BUS_ADDRESS \
  chromium --headless=new --no-sandbox --remote-debugging-port=9333 \
  --user-data-dir=/tmp/lt-profile about:blank &
node tools/lt-cdp.mjs 9333 first
# kill chromium, launch again with the SAME profile, then:
node tools/lt-cdp.mjs 9333 second
# /tmp/lt-requests.log must show ZERO requests during the second load
```

## Project structure

- `src/` — React UI + app shell (`main.tsx`, `components/`, `test/`)
- `src/store` — Automerge recipe store (one doc per recipe, `recipe-index`
  doc, `localStorage` URL persistence)
- `src/importers` — `photoImport.ts` (local photos → data URLs),
  `urlImport.ts` (user-initiated URL import — the app's only `fetch()`)
- `android/` — Capacitor native Android project (app id
  `kitchen.longtable.app`)
- `public/` — PWA icons, favicon, manifest assets
- `tools/` — zero-network verification harness (`lt-server.py`,
  `lt-cdp.mjs`)

## Test

```sh
npx tsc --noEmit   # typecheck (also runs as part of npm run build)
npx vitest run     # unit tests (npm test)
```

## License

AGPLv3 (proposed per project plan — to be confirmed). See `LICENSE`.
