# Longtable — Phase 0: Local cookbook

Local-first recipe box. Phase 0 is the local cookbook only: **no sync, no
network**. Everything runs on-device; recipes live in Automerge documents in
IndexedDB.

## Stack

- Vite + React + TypeScript
- PWA via `vite-plugin-pwa` (`generateSW`, precache everything,
  `navigateFallback: index.html`)
- Automerge: `@automerge/automerge` + `@automerge/automerge-repo` +
  `@automerge/automerge-repo-storage-indexeddb`
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
