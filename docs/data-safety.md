# Data-safety groundwork — for a future Play data-safety declaration

**Status: groundwork, not a filed declaration.** Nothing in this file
has been submitted to Google Play, and nothing here should be copied
into the Play Console form verbatim. It maps the facts in
[privacy-policy.md](privacy-policy.md) onto the questions a Play
data-safety declaration asks, so the person filing it (a user-side
step — the developer does not file store forms from this repo) can
answer from traced facts instead of re-deriving them. Re-verify each
answer against the code at filing time; the form's wording changes,
and this file is written against the form as understood in November
2026.

## The one-line answer

The app itself **collects no data**. It has no accounts, no analytics,
no ads, no crash reporting, and no third-party SDKs. Data leaves the
device only to services the user configures (their hub, their
publishing server) or to people the user chooses (friends, share-code
holders, readers of public recipes). The hard questions for the form
are all boundary questions — whether user-directed transmissions to a
user-chosen server count as data the *app* "collects" or "shares" —
and they are listed as open questions in §5, not answered here.

## 1. Data collected and shared — per data type

Play's form asks, for each data type, whether the app collects it,
whether it shares it, and for what purpose. The table below is the
groundwork for those answers. "Collected by the app" means the app or
the developer receives or retains it; "sent by the user" means the
user's device transmits it to a service the user chose, or to a person
the user chose.

| Data type | Collected by the app? | Sent by the user, and to whom | Purpose |
|---|---|---|---|
| Recipes + photos (user content) | No | Yes — friends-only: ciphertext to chosen friends via friend channels; one-off: plaintext to anyone holding the share code; public: signed records + photo blobs to the author's PDS, indexed by the hub AppView | The app's own function: sharing and publishing the user's recipes, only when the user does so |
| Device identity (DID, public key) | No | Yes — DIDs travel with pairing hellos, friends-only envelopes, and public records, to the hub/PDS/friends involved | Pairing, encryption addressing, and public-record signatures |
| Friends' DIDs + display names | No | Yes — stored on-device; shared with nobody except as addressing for friends-only envelopes | The friends feature |
| PDS account credentials (handle + password/app password) | No | Yes — to the user's chosen PDS only, at sign-in (`src/public/atproto.ts`, `createSession`) | Publishing sign-in |
| Search queries (Discover) | No | Yes — to the configured hub's AppView | Finding public recipes |
| IP address / network metadata (presence, signaling topics, packet sizes) | No — the app does not record it | Visible to the configured hub, STUN/TURN servers, and peers during pairing and sync, as a property of making the connection | NAT traversal and relay; not recorded by the app |
| Location | No — no location permission, never read | No | — |
| Contacts, messages, files outside the cookbook | No | No | — |
| Financial, health, or other sensitive data | No | No | — |
| Crash logs, diagnostics, analytics | No | No | — |

Notes for the filer:

- **Friends-only ciphertext is not "shared" in the advertising sense.**
  It is end-to-end encrypted under keys the hub never holds
  (`src/friends/shelf.ts`); the relay sees ciphertext. How the form
  treats E2E-encrypted user content sent to the user's own chosen
  contacts is a filing judgment — say what it is (encrypted, to chosen
  friends, via the user's hub), do not call it "not shared" without
  saying why.
- **Public recipes are public by definition.** A published recipe is
  a signed public record on the author's PDS, indexed by the hub
  AppView. That is the user publishing, not the app collecting.
- **The one-off share code is plaintext by design**
  (`src/p2p/share.ts:19-20`). If the form asks about data shared with
  third parties, a share code handed to a stranger is the user sharing
  a recipe with that person — the app is the courier, not the
  collector.

## 2. Purposes

Every transmission above has one purpose: the feature the user
invoked (pairing, friends-only sharing, one-off sharing, publishing,
discovery, URL import). There is no secondary purpose — no analytics,
no advertising, no personalization, no sale. If the form offers
"app functionality" as a purpose, that is the one; do not select
analytics, advertising, or marketing for any type.

## 3. Data security

- **Encryption in transit.** Friends-only content is secretbox
  (XSalsa20-Poly1305) end-to-end before it reaches any relay; WebRTC
  itself is DTLS-encrypted; hub/PDS/AppView connections are
  wss/https when the user configures TLS endpoints. Caveat, stated
  plainly: the built-in default hub uses plaintext loopback endpoints
  (`http://localhost:3210`, `http://localhost:2583`) — development
  endpoints that reach nothing on a real phone — and the app's endpoint
  validator refuses plaintext URLs for non-loopback hosts
  (`src/hubs/endpointUrls.ts`). A user-configured hub over plain HTTP
  would send that hub's traffic unencrypted; the app does not force
  TLS on user-configured endpoints. Do not claim "all data encrypted
  in transit" without that qualifier.
- **Encryption at rest.** Crown-jewel secrets (identity key, recipe
  keys, pair secrets, session tokens, API token, TURN credentials,
  share secrets) are held in the Android Keystore on native
  (`docs/keystore-secrets.md`). Recipes live in IndexedDB on-device.
  The encrypted backup is Argon2id + secretbox under a passphrase the
  app never stores (`docs/backup.md`).
- **Data deletion.** In-app delete removes the recipe from the device,
  tombstones friends' copies on next sync, and unpublishes the public
  record (needs a publishing sign-in; see privacy policy §4).
  Uninstalling wipes all local data. There is no account to delete in
  the app; a PDS account is deleted through the PDS operator.
- **No data is sold, no data shared for advertising.** There are no
  SDKs and no partners; there is nothing to list.

## 4. Third parties

The app sends data only to services the user configures: their hub
(signaling, TURN, AppView, bundled PDS) and their PDS. It has no
analytics provider, no ad network, no crash-reporting service, and no
other third-party recipient. Whether a user-configured, possibly
self-hosted hub counts as a "third party" for the form is a filing
judgment (see OQ2) — the honest statement is "data goes only to
servers the user configures, and to people the user shares with; the
app has no third-party data recipients of its own."

## 5. Open questions for the filer

Do not file until these are decided; each is a judgment the code
cannot make.

- **OQ1 — Children / age.** The app has no age gate and collects no
  account data. The form may still need an explicit answer about
  children's data. Decide with the privacy policy's OQ1.
- **OQ2 — Hub metadata as "collected" data.** The app records no IP
  addresses, presence, or search terms — but the hub operator
  necessarily sees them while relaying. Does the form count that as
  data the app collects or shares? The groundwork answer is "the app
  collects none; the user's chosen server sees network metadata as a
  property of the connection" — but the filer should check the form's
  current definitions before submitting that.
- **OQ3 — Self-hosted hub as "third party".** If the user runs their
  own hub, the "recipient" is the user. If they use someone else's hub,
  the recipient is that operator. The form may want one answer; the
  filer should answer for the common case (a hub someone else runs)
  and say so.
- **OQ4 — Photos.** Photos leave the device only when the user
  publishes a recipe with photos or shares one. If the form asks
  whether the app collects photos, the accurate answer is "the user
  shares photos they choose, through publishing/sharing; the app
  collects none."
- **OQ5 — Privacy-policy URL.** Play requires a hosted privacy-policy
  URL, not a repo file. Hosting `docs/privacy-policy.md` somewhere
  stable (and keeping it in sync with the repo copy) is a release
  step that must happen before filing. Do not file with a placeholder
  URL.
- **OQ6 — Account deletion.** The app has no account, so there is no
  in-app account deletion. If the form requires an account-deletion
  statement, the accurate one is: "no account exists in the app;
  deleting a PDS account is done with the PDS operator."

## Sources

`docs/privacy-policy.md` (and its Sources section) is the authority
for every fact above. The files that decide the boundary questions
are `src/friends/shelf.ts` (friends-only crypto),
`src/p2p/share.ts:19-20` (plaintext share snapshot),
`signaling/PROTOCOL.md` (what a hub sees),
`src/public/atproto.ts` (PDS credentials),
`src/hubs/endpointUrls.ts` (plaintext-endpoint rules), and
`docs/keystore-secrets.md` (at-rest secrets).
