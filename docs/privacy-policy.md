# Privacy policy — Longtable (Android app)

This is the privacy policy for the Longtable Android app. It describes
what the app does with data, as of the current `main` branch of
[`github.com/crudobi/longtable`](https://github.com/crudobi/longtable).
Every claim below traces to the code or the developer docs named in
[Sources](#sources); where the code leaves a question open, the doc
says so in [Open questions](#open-questions) instead of asserting an
answer.

When the app is submitted to Google Play, the store listing will need
a hosted URL for this policy. Hosting it is a release step; this file
is the policy text, not the hosted URL.

## Summary

- **Local-first.** Your recipes, friends, and identity live on your
  device. Cooking, importing, and backing up work offline with no
  account and no server.
- **No accounts for local use.** The app never asks for an email, a
  phone number, or a password to cook. An identity (a device keypair)
  is created on the device only when you pair with friends or publish.
- **No analytics, no ads, no trackers.** The app has no analytics SDK,
  no advertising SDK, no crash reporting, and no update check. It
  contacts the network only for things you asked for. This is audited,
  not just asserted: `e2e/telemetry-audit.sh` packet-captures a full
  session and fails on any unexpected endpoint.
- **The developer collects no data.** Nothing the app does sends data
  to the developer. Data leaves the device only to services *you*
  configure (your hub, your publishing server) or to people *you*
  choose (your friends, anyone holding a share code, anyone reading a
  public recipe) — see [Data that leaves your device](#data-that-leaves-your-device-and-when).
- **No data is sold, and no data is shared for advertising.** There is
  nothing to sell: the app collects nothing, and it has no advertising
  partner to share with.

## Data that stays on your device

- **Recipes.** One document per recipe, stored on-device in IndexedDB
  (`src/store/`, `docs/architecture.md` — "store"). Photos you attach
  are stored with the recipe.
- **Identity.** One Ed25519 keypair per device, generated on the
  device. The private key never leaves the identity module
  (`src/identity/`). On Android it is held in the Android Keystore
  (see `docs/keystore-secrets.md`); the public half is your device DID
  (`did:key:z…`).
- **Secrets.** The identity key, per-recipe friends-only keys, friend
  pair secrets, publishing session tokens, the localhost-API token,
  hub TURN credentials, and P2P share secrets are crown-jewel secrets
  held in the Android Keystore on native (same doc). They are never
  written to a file you can see, never logged, and never sent anywhere
  except as described below.
- **Backups you make.** The plaintext export (recipes + friends by
  name and DID) holds no secrets by design; the encrypted backup
  (`.ltbackup`) holds the restorable state under an Argon2id passphrase
  the app never stores and cannot recover (`docs/backup.md`). Both are
  files *you* create through the Backup panel and keep yourself — the
  app never uploads them anywhere.

## Data that leaves your device, and when

Nothing in this section happens on its own. Each item happens only
when you do the thing that causes it.

### 1. Friends-only shares — ciphertext to friends you chose

When you share a recipe friends-only, the app encrypts it under a
random per-recipe key (libsodium secretbox, XSalsa20-Poly1305, fresh
nonce per version) and sends each chosen friend a sealed-box key
envelope addressed to their device DID, plus a signed manifest listing
share IDs and key IDs — never titles (`src/friends/shelf.ts`). The
channel carries ciphertext and manifests exclusively.

Who sees what: your friends (who can decrypt their own envelopes);
the hub relaying the traffic, which sees ciphertext plus room/topic
presence and packet sizes, never plaintext. A friend you later unfriend
stops receiving new versions (the recipe key is rotated), but copies
they already received stay readable on their device — the app says so
where you unfriend, because revocation is forward-only by design
(`docs/accepted-risks.md`, Sec L4).

### 2. One-off shares (QR code / paste) — plaintext to anyone holding the code

A one-off share is different from a friends-only share, and the app
does not hide the difference: the share code (QR or paste text)
carries the recipe itself in plaintext (`src/p2p/share.ts`: "the
embedded snapshot is the recipe itself in plaintext — a QR guest holds
no key yet"). Anyone who scans or pastes the code can read the recipe
and join the live share room; live edits flow to the room until
sharing is stopped. Treat a share code like a photocopy: do not send
it to anyone you would not hand the recipe to.

### 3. Pairing — signed hellos and network metadata

Pairing by invite code sends signed hellos (your DID, the inviter's
DID, a pair secret) through the configured hub's signaling server.
The signaling server sees room names (topics) and presence — who is
in which room — and forwards handshake messages it cannot read
(`signaling/PROTOCOL.md`). Pairing by hand ("Pair without a hub")
exchanges the same signed handshake directly between the two devices
as copy/paste blobs, with no server in the path; the offer blob carries
the pair secret, so treat it like an invite code, and the app clears
it from the URL bar after pickup.

During pairing, and during any WebRTC connection, your device exchanges
ICE candidates with the peer and with the STUN/TURN servers of your
configured hubs. Those servers learn your IP address (and the peer's),
and a TURN relay carries your encrypted WebRTC traffic. They never see
plaintext recipe content: friend traffic is secretbox-encrypted before
it reaches the relay, and the relay itself is DTLS-encrypted WebRTC
(`signaling/PROTOCOL.md`, "Privacy cost, stated plainly").

### 4. Public publishing — public records on your publishing server

Publishing is optional and only for recipes you mark public. It writes
a signed `kitchen.longtable.recipe` ATProto record, plus your photos as
blobs, to the publishing server (PDS) you signed into, and the hub's
AppView indexes the public record so anyone can find it in Discover
(`src/public/publish.ts`, `docs/public-protocol.md`). A public recipe
is public by definition: anyone who can reach your PDS or the hub's
AppView can read it, including its photos.

To sign in to a PDS you give the app a handle and a password (or app
password). Those credentials go to that PDS only, over its own
connection (`src/public/atproto.ts`, `createSession`), and the session
token is kept in the Keystore. The app never sends your PDS
credentials anywhere else.

Unpublishing deletes the record from your PDS and purges the hub's
cached copy of its photos (`appview/media.mjs`, `purgeImages`). That
step needs a publishing sign-in: if you are signed out, the public
copy stays live until you sign in under Publishing and unpublish
again. Copies other people already saved are theirs — deleting your
public recipe cannot recall a copy someone else saved, and a copy on a
device that never syncs again is out of reach (friends' copies are
recalled by tombstone when their devices next sync;
`src/recipeFlows.ts`, `TOMBSTONE_NOTICE`).

### 5. Discover search — your search terms go to your hub's AppView

A Discover search sends your search terms to the AppView of your
configured hub. The hub's operator sees the query and your IP address.
Search-result cards are marked "Unverified — open to verify": the
summary alone cannot be signature-checked, and opening a card verifies
the full record against the author's PDS before anything is displayed
(`src/components/DiscoverPanel.tsx`, `src/public/discover.ts`).

### 6. URL import — the page you asked for is fetched

When you import from a web page, the app fetches the URL you entered
(`src/importers/urlImport.ts`). That site sees a normal page request
from your device. Nothing else is fetched on your behalf.

### 7. Localhost API (opt-in, off by default) — loopback only

The localhost API lets scripts and apps on your own device read and
write your cookbook over HTTP on loopback only (`127.0.0.1`), guarded
by a per-install bearer token (`docs/localhost-api.md`). It is off by
default. The token is the whole access control: any app on the device
holding it can read and write the cookbook, including private and
friends-only recipes (accepted risk Sec L6 in
`docs/accepted-risks.md`). Enable it only if you understand that, and
treat the token like a password.

### 8. Camera — QR decoding happens on the device

The CAMERA permission is optional and used only to scan QR codes
(share codes and friend invites). Decoding runs on the device with the
platform barcode detector over the camera stream (`src/qrscan.ts`);
camera frames never leave the device.

## What the app does not do

- No analytics or telemetry of any kind, audited by
  `e2e/telemetry-audit.sh` (see Summary).
- No advertising, no advertising SDKs, no data sold or shared for
  advertising.
- No crash reporting.
- No update check, no kill switch, no forced update, and no
  phone-home: the app never contacts a developer server to ask
  anything (no update-check code exists in `src/`).
- No third-party SDKs that receive data. The only network peers are
  the ones you configure (your hubs, your PDS) and the people you
  share with.
- No location permission, and the app never reads your location.

## Permissions

- `INTERNET` — required: sync, publishing, and Discover all need the
  network, and only for the things above.
- `CAMERA` — optional: QR-code scanning only. Denying it leaves the
  paste path working (`android/app/src/main/AndroidManifest.xml`).

## Your choices, and deleting data

- **Cook without any of it.** Local cooking needs no account, no hub,
  and no network.
- **Delete a recipe** in the app: it leaves this device, friends'
  copies are tombstoned on next sync, and the public record is removed
  as described in §4.
- **Unfriend someone:** they stop receiving new versions of shared
  recipes; copies they already have stay readable (forward-only
  revocation — see §1).
- **Uninstall the app:** removes everything it stored on the device.
  Android auto-backup is off, so make an encrypted backup first if
  you want your recipes back (`docs/backup.md`).
- **No account to delete.** The app holds no account. If you signed
  into a PDS, deleting that account is the PDS operator's process,
  not the app's — see below.

## Hubs and publishing servers you choose are third parties

The app itself is local-first, but the moment you configure a hub or
sign into a publishing server, you are trusting that operator with
whatever the protocol sends them: the hub sees signaling topics and
presence plus relayed ciphertext (§1, §3); the AppView sees your
Discover queries (§5) and indexes your public records (§4); the PDS
holds your account and your public records under its own practices
(§4). The built-in hub is not a service — it points at
developer-only endpoints that reach nothing on a real phone (see the
README, "What works out of the box"). If you use a hub or PDS someone
else runs, check that operator's own policy: this policy covers the
app, not their server.

## Changes to this policy

Changes land in this file in the repository, as part of the app's own
history. The app has no update check, so you only get a new policy
with a new release you choose to install.

## Contact

Privacy questions about the app: the maintainer, Crud
<crudobi@proton.me> (the address on the sign-off of every commit in
this repository, and the contact in `TRADEMARKS.md`).

## Open questions

Things this policy does not assert, because the code does not settle
them. Each needs a decision before the policy is filed anywhere that
asks for it.

- **OQ1 — Children / age.** The app has no age gate and collects no
  account data, so there is nothing age-specific to state about the
  app itself. Whether a store form needs an explicit children's-data
  answer is a filing decision (see `docs/data-safety.md`).
- **OQ2 — Hub metadata in store forms.** The app itself collects no
  data, but a hub operator necessarily sees network metadata (IP
  address, presence/topics, search terms) when you use their hub.
  Whether that counts as data "collected" by the app for a Play
  data-safety declaration is a filing decision (see
  `docs/data-safety.md`).
- **OQ3 — Your PDS's own practices.** When you sign into a PDS — your
  own hub's bundled one, or a third-party ATProto PDS — that operator
  handles your account data under its own policy. This policy cannot
  state their practices; check with them.
- **OQ4 — Future telemetry.** There is none today. If any telemetry or
  crash reporting is ever added, this policy must be updated first,
  and the no-telemetry audit (`e2e/telemetry-audit.sh`) must be
  updated with it — not after.
- **OQ5 — Localhost API residual.** The token-is-the-whole-access
  statement in §7 is an accepted risk (Sec L6), not a bug. If per-tier
  API scopes ever land, §7 must be rewritten to match.

## Sources

Every claim above traces to one of these (all paths relative to the
repo root):

- Storage and identity: `src/store/`, `src/identity/`,
  `docs/architecture.md`, `docs/keystore-secrets.md`.
- Friends-only crypto: `src/friends/shelf.ts`,
  `src/friends/service.ts`, `docs/accepted-risks.md` (Sec L4).
- One-off shares: `src/p2p/share.ts:19-20` (plaintext snapshot, by
  design).
- Pairing and signaling: `src/friends/friends.ts`,
  `src/friends/manualSdp.ts`, `signaling/PROTOCOL.md`.
- Publishing and discovery: `src/public/publish.ts`,
  `src/public/atproto.ts`, `src/public/discover.ts`,
  `docs/public-protocol.md`, `appview/media.mjs`.
- Tombstones: `src/recipeFlows.ts` (`TOMBSTONE_NOTICE`).
- Localhost API: `docs/localhost-api.md`,
  `docs/accepted-risks.md` (Sec L6).
- Backups: `docs/backup.md`, `src/backup/`.
- QR scanning: `src/qrscan.ts`.
- No telemetry: `e2e/telemetry-audit.sh`, README "Network policy".
- Permissions: `android/app/src/main/AndroidManifest.xml`.
- Default hub (developer-only endpoints):
  `src/hubs/hubs.ts` (`DEFAULT_HUB`).
