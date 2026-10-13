# Architecture — module map and stable boundaries

One TypeScript codebase: a Vite + React PWA, wrapped for Android with
Capacitor. Server-side pieces are plain Node (`appview/`, `hub/`,
`signaling/`, `services/`). This map names each module's job, its public
interface (the exports other code — including yours — may rely on), and
the boundary rules that keep the system extensible.

```
src/
  store/      local recipe storage (Yjs docs in IndexedDB)
  identity/   device identity: did:key (Ed25519) via libsodium
  p2p/        one-off recipe sharing rooms (y-webrtc)
  friends/    friend pairing, encrypted channels, friends-only shelves
  public/     ATProto publishing, discovery, the visibility byte-paths
  hubs/       hub registry (endpoints only — never content)
  importers/  Importer API v1: contract, registry, reference importers
  components/ React UI (panels/modals; no business logic)
appview/      hub-side public index (verify-then-index, FTS5 search)
hub/          the single-artifact hub bundle (all hub roles, one tarball)
signaling/    the WebSocket signaling server (standalone)
services/     the local ATProto testnet used in development/proofs
lexicons/     kitchen.longtable.* record schemas
```

## store — `src/store/`

The source of truth for everything local. One Yjs document per recipe,
persisted to IndexedDB (`longtable:recipe:<guid>`), plus one index doc.

- `repo.ts` — the Yjs store handle. `getRepo()`, `getOrCreateDoc(store,
  guid)`, `docUrl(guid)`. Also owns the per-device Yjs clientID
  persistence (a fresh random clientID per launch breaks merge
  tie-breaks; the persisted ID is load-bearing).
- `recipes.ts` — the recipe CRUD interface the whole app uses:
  `getOrCreateIndex`, `createRecipe`, `getRecipe`, `updateRecipe`,
  `deleteRecipe`, `listRecipes`, `registerSharedRecipe` (P2P joins).
  Types live in `src/types.ts`: `Recipe`, `RecipeInput`, `RecipePatch`,
  `RecipeSummary`, `VisibilityTier`.
- `migrateFromAutomerge.ts` — the Phase 0→1 recovery migration
  (flag-guarded, dynamic import). Storage-format changes must ship with
  a migration and an upgrade test; that rule is enforced by CI.

**Boundary:** nothing outside `store/` touches Yjs documents or
IndexedDB directly. Sync layers exchange whole `Recipe` values through
this interface.

## identity — `src/identity/`

One Ed25519 keypair per device, generated and kept on-device.

- `identity.ts` — `getOrCreateIdentity()`, `identityFromSeed()`,
  `signDetached()`, `verifyDetached()`, `didFromPublicKey()`,
  `publicKeyFromDid()`, `encPublicKeyForDid()` (the encryption identity
  is derived from the signing key: Ed25519→Curve25519). `Identity` =
  `{ did, publicKey, … }`; the DID is `did:key:z…` (base58btc).
- `codec.ts` — base64 / UTF-8 / hex helpers shared by all crypto users.

**Boundary:** private key material never leaves this module; callers get
signatures and public keys, never the seed.

## p2p — `src/p2p/share.ts`

One-off sharing: one y-webrtc room per shared recipe
(`longtable-share-<id>`). A share payload (JSON, shown as QR + paste
text) carries the room and the hub's signaling endpoint. Entry points:
`shareRecipe`, `joinShare`, `parseSharePayload`, `rejoinShares`,
`onShareUpdate`, `destroyAllShareProviders`, `peerCount`. Concurrent
edits merge through Yjs; there is no server copy.

## friends — `src/friends/`

Friend pairing and friends-only sharing (Phase 2).

- `friends.ts` — pairing + channels. Invites (v2) carry the inviter's
  DID, a one-time pairing room, and a 32-byte pair secret; both sides
  exchange signed hellos (`longtable-pair:<room>:<did>`) and the guest
  pins the inviter's DID from the invite, so substitution fails. Each
  pair gets a persistent channel room derived from
  `BLAKE2b-256(pairSecret)`; the y-webrtc room password is the pair
  secret. Interface: `createFriendInvite`, `parseFriendInvite`,
  `runPairing`, `listFriends`/`getFriend`/`saveFriend`/`removeFriend`,
  `joinFriendChannel`, `rejoinFriendChannels`, `onChannelUpdate`.
- `shelf.ts` — the friends-only cryptography. Each shared recipe gets a
  random secretbox key, kept in an owner-only local vault (`loadVault`,
  `ensureRecipeKey`, `getRecipeKey`). What enters the channel is only:
  ciphertext, one sealed-box (`crypto_box_seal`) key envelope per
  authorized friend, and a **signed shelf manifest** listing share IDs
  and key IDs — never titles. `buildManifest`, `verifyManifest`,
  `publishShare`, `unpublishShare`, `processChannel` (receiver side:
  verify manifest → find my envelope → decrypt; every failure is an
  explicit, named result — `no key envelope addressed to me` etc.).
- `service.ts` — the app-facing orchestration: `shareRecipeWithFriends`,
  `republishIfShared`, `unshareRecipeEverywhere`, `unfriendAndRekey`
  (rotate the recipe key, republish to remaining friends, unpublish from
  the removed friend's channel — revocation is forward-only by design),
  `importReceivedShares`, `listReceivedShares`, display-name helpers.

**Boundary:** plaintext friends-only content exists only inside `store/`
documents and this module's decrypt path. The channel carries ciphertext
and manifests exclusively.

## public — `src/public/`

Public publishing on ATProto (Phase 3) — see
[public-protocol.md](public-protocol.md) for the wire contract.

- `atproto.ts` — a minimal hand-rolled XRPC client (`AtprotoClient`:
  `createSession`, `refreshSession` with one retry, `putRecord`,
  `deleteRecord`, `getRecord`, `uploadBlob`, `getBlob`), the session
  store, and the local publications registry. Errors are `AtprotoError`
  (`status`, XRPC `error` name).
- `publish.ts` — local recipe ⇄ `kitchen.longtable.recipe` record.
  `buildRecipeRecord` is pure; `canonicalRecipeHash`,
  `recipeSignatureMessage`, `signRecipeRecord` implement the device
  signature scheme exactly as the protocol doc specifies;
  `ensurePubkeyBinding` maintains the `kitchen.longtable.pubkey`
  record; `publishRecipe` / `unpublishRecipe` do the byte movement.
- `discover.ts` — AppView reads: `searchAppView`,
  `fetchPublicRecipe`, `publicRecordToInput` (a public record becomes
  an ordinary local `RecipeInput` — "save a copy").

**Boundary:** visibility changes are byte movements performed here and
in `friends/service.ts` (the App component orchestrates): going public
writes the record *then* flips the tier; going private deletes the
record *first*. The local document is always the source of truth.

## hubs — `src/hubs/hubs.ts`

The hub registry: `HubConfig { id, name, signalingUrl, stunUrl?,
turnUrl?, turnUsername?, turnCredential?, appviewUrl, pdsUrl }` in
localStorage (`longtable:hubs:v1`). `listHubs`, `getActiveHub`,
`addHub`, `removeHub`, `setActiveHub`, `updateHub`,
`getSignalingUrls()`, `getIceServers()`.

Design rule: **hubs are rendezvous, not repositories.** Clients hand
y-webrtc *every* configured hub's signaling URL (peers rendezvous on any
shared live hub) and aggregate ICE servers across all hubs. Switching
the active hub rebuilds only network providers — docs, friends, shares,
and identity are hub-independent, so switching loses nothing by
construction.

## importers — `src/importers/`

The extension point most third parties will touch; specified fully in
[importers.md](importers.md). `contract.ts` (API v1 types +
`validateImportedRecipe` + `assertImporterShape`), `registry.ts`
(built-ins + lazy drop-in plugin discovery from
`src/importers/plugins/`, `runImporter` as the single validated path),
reference importers `urlImporterAdapter.ts` (web pages, JSON-LD/
OpenGraph), `jsonImporter.ts`, `mealieImporter.ts`, plus
`photoImport.ts` (local photo attach + downscale).

## appview — `appview/` (Node)

The hub's public index. `ingest.mjs` consumes the PDS repo firehose
(`com.atproto.sync.subscribeRepos`) filtered at the consumer to
`kitchen.longtable.recipe` + `kitchen.longtable.pubkey` only
(`WANTED_COLLECTIONS`). **Verify-then-index:** a record enters the
SQLite FTS5 index (`db.mjs`, `RecipeIndex`) only after `verify.mjs`
validates the repo commit signature against the DID-document key and
the record's CID appears in the verified repo state. `server.mjs`
serves the read API (see the protocol doc) plus the content-addressed
public media cache (`media.mjs`, `GET /media/:did/:cid`). The AppView
verifies *repo authorship*; device-signature verification is the client
layer (also specified in the protocol doc).

## hub — `hub/`

The deployable unit: one tarball (`longtable-hub-<version>.tar.gz`),
one config file, `./longtable-hub start`. `hub.mjs` supervises the PWA
static host, signaling (TLS), coturn (generated config), the AppView,
and optionally a managed PDS. Anyone can run one; clients carry a hub
*list*, so no hub is special.

## UI — `src/components/`

React panels/modals over the modules above: `RecipeList`,
`RecipeDetail`, `RecipeForm`, `FriendsPanel`, `FriendShareModal`,
`ShareModal`, `JoinModal`, `DiscoverPanel`, `ImportPanel`,
`PublishSettingsModal`, `HubSettingsModal`, `UrlImportDialog`.
All user-facing failures render through `src/friendlyError.ts`
(plain-language mapping; raw transport errors never reach the UI).

## Tests and proofs

- Unit: `src/test/*.test.ts` (vitest) + `appview/test/` — run by CI.
- Device gate: `e2e/test.mjs` (Appium, DOM-verified interactions) —
  install, CRUD, offline, photos, URL import, first-run state, the
  unfriend caveat, the importer UI.
- Oath proofs: `e2e/proof-*.mjs` (P2P convergence, friends-only
  confidentiality incl. unfriend/re-key, public forge-resistance +
  privacy audit, storage migration, hub-death failover) and
  `e2e/telemetry-audit.sh`.
- CI: every commit to `main` runs typecheck → unit tests → AppView
  tests → web build → cap sync → APK → e2e gate → migration proof →
  publish (only if all green).
