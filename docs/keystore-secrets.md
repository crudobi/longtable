# Keystore secret storage (Wave 3, security H1)

## The finding

Every crown-jewel secret lived in plaintext `localStorage`:

| Secret | Key | Home |
| --- | --- | --- |
| Device identity Ed25519 secret key | `longtable:identity-secret` | `src/identity/identity.ts` |
| Per-recipe symmetric keys (vault) | `longtable:key-vault` | `src/friends/shelf.ts` |
| Friend records incl. pair secrets | `longtable:friends` | `src/friends/friends.ts` |
| ATProto JWTs (access + refresh) | `longtable:atproto-session` | `src/public/atproto.ts` |
| Loopback API settings incl. token | `longtable:localapi` | `src/localapi/settings.ts` |
| Hub registry incl. TURN credentials | `longtable:hubs:v1` | `src/hubs/hubs.ts` |
| P2P share records incl. room secrets | `longtable:shares` | `src/p2p/share.ts` |

One XSS — or one read of the WebView's storage files — was total
permanent compromise, and no identity rotation exists. No XSS vector
was found in `src/` (zero `innerHTML` / `dangerouslySetInnerHTML` /
`document.write`), so this was latent. The seventh key
(`longtable:shares`) was not in the original finding's list of six;
it was found by reading the code — share records carry the 32-byte
room secret used as the y-webrtc password, so they are secrets too.

## Mechanism chosen: purpose-built `SecureStore` Capacitor plugin

Native half: `android/app/src/main/java/kitchen/longtable/app/SecureStorePlugin.kt`
(`@CapacitorPlugin(name = "SecureStore")`, registered in
`MainActivity` next to `LocalApiPlugin`). JS half:
`src/secrets/secureStorePlugin.ts`. The native side owns only
encrypted key/value storage: AndroidX `EncryptedSharedPreferences`
over a `MasterKey` held in the Android Keystore (AES256_GCM; key
encryption AES256_SIV, value encryption AES256_GCM). Methods:
`isAvailable`, `get`, `set`, `remove`, `keys` (key names only).
Dependency: `androidx.security:security-crypto:1.1.0-alpha07`. The
`MasterKey` (singular) Builder API used by the plugin arrived in
1.1.0-alpha01; 1.0.0 only has the deprecated `MasterKeys` alias-string
API and does not compile against this plugin (verified: the first
`assembleDebug` failed on `Unresolved reference 'MasterKey'` until
the bump). 1.1.0 never went stable; alpha07 is the long-lived
de-facto release most apps pin.

### Evaluated alternatives

- **Capawesome `@capawesome-team/capacitor-secure-preferences`** —
  the most complete community option, Capacitor 8, same crypto.
  Rejected: it is paywalled ("only available to Capawesome
  Insiders", private npm registry). A paid private-registry
  dependency is unacceptable for this AGPL local-first app.
- **`@aparajita/capacitor-secure-storage`** — free, Capacitor 8,
  AES-GCM + Keystore, `localStorage` on web. Viable, but a new
  third-party dependency with its own key naming and no migration
  hook; the app would still need its own migration, routing, and
  degraded-mode layers on top.
- **`capacitor-secure-storage-plugin` / `@evva/capacitor-secure-storage-plugin`** —
  same class (Keystore + SharedPreferences). Their docs carry the
  Auto Backup footgun explicitly: a backed-up ciphertext file
  restores without its Keystore key and can never be decrypted.
- **Purpose-built (chosen)** — the surface is tiny (~150 lines of
  Kotlin using Google's recommended mechanism), the repo already has
  the custom-plugin precedent (`LocalApiPlugin.kt` + `plugin.ts` +
  `MainActivity` registration), key naming and migration semantics
  stay owned by the app, and no new npm supply-chain dependency is
  added. The user rule "tools in Go or Rust, single binary" does not
  apply: a Capacitor plugin is necessarily Kotlin/Java + TypeScript.
  The Auto Backup footgun does not apply here either:
  `android:allowBackup="false"` is already set in the manifest, so
  the ciphertext file is never backed up anywhere the Keystore key
  does not exist.

## Which secrets moved

All seven keys above. None left behind. Each moves as a whole
stored value (e.g. the whole friends array, the whole hub registry):
splitting secret fields out of their records would have meant new
formats and new failure modes for no gain — the records are small
and the store is encrypted as a unit.

What stays in `localStorage` (not secrets): the publications
registry (URIs/CIDs — public info), AppView URL override, recipe
index URL, Yjs client id, and the
`longtable:secrets-migrated-v1` migration marker itself. Two
non-secrets ride the shared accessor kv and therefore land in the
Keystore on native too — the display name and the received-shares
mapping (`src/friends/service.ts` defaults its kv to `secretKv`
alongside the secret accessors). That is harmless (they are not
secrets, just stored encrypted alongside them); splitting their kv
parameter out would be churn for no gain.

## The async problem: async init + sync in-memory mirror

Keystore access is async; the identity/vault/friends/session
accessors are sync and their signatures are frozen (the C3 backup
worker reads secrets through the same accessors). The refactor:

- `src/secrets/secretStore.ts` owns a routing store, `secretKv`,
  now the default `kv` for every secret accessor. Signatures and
  return shapes are unchanged — only the default store object
  changed, and tests passing an explicit `kv` are unaffected.
- `src/main.tsx` awaits `initSecrets()` BEFORE first render, so
  the mirror is hydrated before any startup reader can run. It
  hydrates an in-memory map from the Keystore; sync reads answer
  from the map. Writes update the map synchronously and persist to
  the Keystore through an ordered async queue, drainable via
  `flushSecrets()` (awaited after identity creation; best-effort
  flush on `pagehide`). `App`'s own init-effect call is memoized
  and returns the same already-resolved report. A rejection still
  renders (degraded mode).
- Pre-render hydration is load-bearing, not cosmetic. The
  `localStorage` fallback only covers values that have NOT been
  migrated yet; for a value already in the Keystore, a read before
  init returns nothing — and a fire-and-forget startup reader
  acting on that empty read never retries. That bit proof-p2p:
  `rejoinShares()` runs outside `App`'s init-effect IIFE,
  concurrently with `initSecrets()`, and on a relaunched app it
  read an empty mirror and rejoined zero share rooms, so the peers
  never converged (while the friends flow, whose
  `rejoinFriendChannels()` runs inside the IIFE after init, was
  unaffected). Hydrating in `main.tsx` closes the hole for every
  startup reader at once (render initializers, `rejoinShares`, the
  localhost-API effect). A unit test pins the contract: a
  Keystore-held value is invisible to a fresh store until
  `initSecrets()` resolves.

## WebView localStorage flush window (proof finding)

The WebView commits `localStorage` to disk asynchronously after a
write, and `am force-stop` SIGKILLs the process: values written
seconds before the kill can be lost before the commit lands. The
migration proof hit this deterministically — the identity secret
(written minutes earlier at old-build launch) migrated every run,
while the loopback token and the seeded hub registry (written
seconds before the kill) came back `absent` from the migration
report and were in neither store afterwards. Waiting 15s between
the last `localStorage` write and the force-stop made all three
values move byte-identical. This is a proof-harness artifact, not
a migration bug: a real upgrade happens long after the last write,
and there is no JS API that forces a WebView `localStorage` disk
flush, so the app cannot do anything about the window. The proof
carries the 15s wait with this explanation in its comment.

## Migration

Per key, Keystore-authoritative and idempotent:

1. Read the Keystore value `K` and the `localStorage` value `L`.
2. If `K` exists: the mirror takes `K`; any `L` is stale and is
   cleared. (A stale `L` can only come from a write that landed in
   the Keystore before a kill skipped the clear.)
3. Else if `L` exists: write `L` to the Keystore, verify by
   read-back equality, and only then clear `L` and populate the
   mirror. A failed write or a read-back mismatch reports
   `failed`, keeps `L` in place, and never claims the move.
4. Else: nothing to move (`absent`).
5. A value written before init finished is authoritative from the
   mirror (`moved-early-write`).

`initSecrets()` returns a per-key report
(`moved` / `moved-early-write` / `already-secure` / `absent` /
`failed` / `degraded` + `legacyCleared`); a second run reports
`already-secure`. On full success the non-secret marker
`longtable:secrets-migrated-v1` is written to `localStorage`.
No credential or key is rotated or re-keyed by the migration —
existing values move as-is.

## Web / PWA path

No Keystore exists in a browser, so on web the secure store is
unavailable and secrets stay in `localStorage` — behavior
unchanged, stated here plainly rather than hidden. No
encrypted-at-rest fallback was built for web: a passphrase scheme
is a product decision (recovery UX, key management), and a key
held next to its ciphertext adds no security. The native Android
app is the hardened path; the PWA keeps the documented
`localStorage` posture.

## Keystore unavailable / app data cleared

- **Keystore unavailable at runtime** (no native plugin, Keystore
  locked or corrupt, device without backing): degraded mode.
  Secrets keep working from `localStorage` exactly as before, and
  the next launch with a working Keystore migrates them. The app
  never breaks for a storage failure.
- **App data cleared / uninstall / `pm clear`**: the
  `EncryptedSharedPreferences` file and the Keystore key are wiped
  together. Consequence: identity, vault, pair secrets, sessions,
  and tokens are gone. The device gets a fresh DID on next launch;
  old friends see a stranger DID and old shares are undecryptable.
  There is no recovery from the device alone — this is inherent to
  device-bound keys with no rotation/recovery, and it is why the
  backup story below matters.
- **Residual kill window**: a force-stop in the milliseconds
  between a secret write and its Keystore flush loses that single
  write. Identity creation awaits its flush; other writes flush
  in order within milliseconds, and the emulator proofs await
  `__ltSecrets.flush()` before any force-stop. The migration
  itself never has this window: it verifies read-back before
  clearing `localStorage`.

## Interaction with the C3 encrypted backup

The C3 backup (parallel Wave 3 worker) MUST remain restorable
after a Keystore wipe. That is a hard interface requirement on
C3, not something this wave implements: the backup's decryption
key must not live only in the Keystore or `localStorage`. C3 must
encrypt the backup under a user-held secret (recovery
passphrase/phrase) or a key escrowed outside the device store.
If C3 instead encrypts under the device identity key or a
Keystore-held key, a wipe makes the backup unrestorable — that
would need to be the coordinator's explicit decision, not a
silent default.

## Honest security boundary

This protects secrets **at rest**: they are no longer in WebView
storage, not extractable from app-private files or backup images,
and not readable by other apps. It does **not** protect against
live in-process XSS: secrets are loaded into JS memory at startup
(the sync accessors require it), so injected script running live
in the WebView could still read the in-memory copies while the
app runs. Closing that last gap needs keys that never leave the
Keystore (native signing/sealing) — a larger refactor, recorded
here as future work. The CSP (`script-src 'self'`) and the zero
`innerHTML` sinks remain the live-XSS defenses.

## Proof

- Unit tests: `src/test/secrets.test.ts` (migration, Keystore-
  authoritative precedence, read-back verification, degraded
  mode, accessor wiring).
- Emulator proof: `e2e/proof-keystore.mjs` — fresh install
  (secrets in Keystore, none in `localStorage`, DID stable
  across restart) and upgrade migration (old build's
  `localStorage` secrets move, DID unchanged).
- Regression: `proof-friends`, `proof-public`, `proof-hubfail`,
  `proof-p2p` were updated to read secrets through the
  `__ltSecrets` debug hook instead of raw `localStorage`
  (proof builds only), and re-run on the fleet.
