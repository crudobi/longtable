# The public recipe protocol

Public Longtable recipes are ordinary ATProto records in the author's
own repository, signed twice: once by the account's repo key (standard
ATProto) and once by the author's Longtable **device key**. Any client
can find, read, and verify them with nothing but this document, the
lexicons in [`../lexicons/`](../lexicons/), and standard ATProto
libraries — the Longtable app is not involved. Private and friends-only
recipes are **not** part of this protocol: no lexicon exists for them,
and they never touch a PDS.

## Records

### `kitchen.longtable.recipe`

One record per public recipe. The app uses the recipe's local ID as the
record key (`rkey`), and repeats it in the record as `longtableId`.
Schema: [`lexicons/kitchen.longtable.recipe.json`](../lexicons/kitchen.longtable.recipe.json).

| Field | Type | Notes |
|---|---|---|
| `name` | string | Recipe title. |
| `description` | string? | |
| `ingredients` | string[] | One entry per ingredient line. |
| `instructions` | string[] | One entry per step. |
| `prepTimeMinutes` / `cookTimeMinutes` | int? | Minutes. |
| `recipeYield` | string? | e.g. `"4 servings"`. |
| `tags` | string[]? | |
| `images` | blob[]? | Standard ATProto blob refs; fetch bytes via `com.atproto.sync.getBlob`, or via an AppView's media cache (below). |
| `deviceDid` | did? | The author's Longtable device identity (`did:key:…`). |
| `deviceSignature` | string? | Base64 Ed25519 detached signature — see below. |
| `longtableId` | string | The recipe's ID in the author's app (= `rkey`). |
| `createdAt` / `updatedAt` | datetime | |

### `kitchen.longtable.pubkey` (the binding)

Record key `self` (a lexicon literal). Binds the author's device key to
the account. Schema:
[`lexicons/kitchen.longtable.pubkey.json`](../lexicons/kitchen.longtable.pubkey.json).

| Field | Type | Notes |
|---|---|---|
| `deviceDid` | did | The device identity, `did:key:z…`. |
| `devicePublicKey` | string | Base64 raw Ed25519 public key (32 bytes). |
| `signature` | string | Base64 Ed25519 detached signature by the device key. |
| `createdAt` | datetime | |

## The two signatures

**1. Repo signature (ATProto itself).** Every repo commit is signed by
the account's signing key, published in the DID document
(`verificationMethod` `#atproto`). A record that appears in a verified
repo export (`com.atproto.sync.getRepo`, checked with
`verifyRepoCar` from `@atproto/repo`) is proven to be the account's.
This layer alone makes records unforgeable as *the account's* records.

**2. Device signatures (Longtable).** These bind records to the
physical device key, so authorship survives account moves and is
checkable without trusting any server.

*Binding signature* — signs the UTF-8 string:

```
longtable-pubkey:v1\n<accountDid>\n<deviceDid>\n<devicePublicKeyBase64>
```

*Recipe signature* (`deviceSignature` on the recipe record) — first
compute the canonical hash: BLAKE2b-256 (libsodium `crypto_generichash`
with 32-byte output), hex-encoded, over the UTF-8 JSON string of this
exact array:

```json
[name, description || "", ingredients, instructions,
 prepTimeMinutes ?? null, cookTimeMinutes ?? null,
 recipeYield || "", tags || [], imageCids]
```

where `imageCids` are the `images[].ref.$link` strings, in order. Then
sign the UTF-8 string:

```
longtable-recipe:v1\n<accountDid>\n<longtableId>\n<hashHex>
```

Both signatures are Ed25519 detached signatures produced by the device
key, base64-encoded in the records.

## Reading and verifying a public recipe (third-party flow)

1. **Find it.** Query any AppView (below) by name or ingredients, or
   crawl a PDS repo directly for the `kitchen.longtable.recipe`
   collection. An AppView is an index, not an authority — treat its
   results as hints.
2. **Resolve the author.** Resolve the account DID (PLC directory or
   `did:web`) to its DID document: the `#atproto` signing key and the
   `AtprotoPersonalDataServer` service endpoint.
3. **Fetch the records from the author's PDS** with plain XRPC:
   `com.atproto.repo.getRecord` for `kitchen.longtable.pubkey/self`
   and for the recipe record — or the whole repo via
   `com.atproto.sync.getRepo`.
4. **Verify the repo** (if you fetched the CAR): `verifyRepoCar`
   against the DID-document key; confirm the record's CID in the
   verified repo state.
5. **Verify the binding:** decode `devicePublicKey` from the pubkey
   record; check `deviceDid` matches `did:key` of that key; verify the
   binding signature over the string above with that key.
6. **Verify the recipe:** recompute the canonical hash from the record
   fields, rebuild the signed string, and verify `deviceSignature`
   with the (now trusted) device public key.

If any step fails, the recipe is not the author's — full stop.
`examples/third-party-client/` implements exactly this flow against an
AppView + PDS; `scripts/verify-public/` is a deeper standalone verifier
(repo audit + forgery self-test) built the same way.

## Writing public recipes

Standard ATProto writes on the author's own PDS:

1. `com.atproto.server.createSession` (handle + app password) →
   access/refresh JWTs.
2. For each photo: `com.atproto.repo.uploadBlob` → blob ref (CID).
3. `com.atproto.repo.putRecord` — `{ repo: <did>,
   collection: "kitchen.longtable.recipe", rkey: <longtableId>,
   record: {…} }`, after attaching `deviceDid` and computing
   `deviceSignature` as above. Publish the `kitchen.longtable.pubkey`
   binding first (rkey `self`) if it isn't in the repo yet.
4. Unpublish: `com.atproto.repo.deleteRecord` for the recipe record.

A record is not a Longtable public recipe unless it conforms to the
lexicon and its device signature verifies against a binding record in
the same repo.

## The AppView API

An AppView indexes verified public recipes and serves reads. It is a
convenience, never an authority: it only indexes records whose repo
signature verified (verify-then-index), and clients can always check
signatures themselves via the flow above. All responses are JSON with
`access-control-allow-origin: *`.

| Endpoint | Response |
|---|---|
| `GET /health` | `{"ok": true}` |
| `GET /search?q=<name>&ingredients=<a,b>` | `{"results": [summary…]}` — `q` is a recipe-name prefix match; `ingredients` is comma-separated with AND semantics (every listed ingredient must match). Either parameter may be omitted. |
| `GET /recipe/:did/:rkey` | The full indexed recipe: `{uri, did, rkey, cid, name, description, ingredients, instructions, prepTimeMinutes, cookTimeMinutes, recipeYield, tags, images, longtableId, createdAt, updatedAt}`. 404 if unknown. |
| `GET /author/:did` | `{"did": …, "results": [summary…]}` — everything indexed for that author. |
| `GET /media/:did/:cid` | Raw blob bytes for a public recipe image, content-addressed; `x-longtable-media-cache: hit\|miss` says whether the AppView served its cache or fetched from the author's PDS. |
| `GET /stats` | Ingest counters (accepted/rejected), index size, media cache stats. A rising `rejected` count is forgery attempts being refused. |

A *summary* is `{uri, did, rkey, name, ingredients, tags, updatedAt}`.

Search semantics are FTS5-backed: name search is a token-prefix match
(`pancak` finds "Pancakes"), ingredient search requires every listed
ingredient token to be present in the recipe's ingredient lines.

## Hubs

A hub bundles the rendezvous/indexing roles (signaling, TURN, AppView,
optionally a managed PDS, PWA hosting) in one deployable artifact
(`hub/`). Clients keep a *list* of hubs and rendezvous friend channels
on any shared live one. Nothing in this protocol depends on a
particular hub existing: records live in authors' repos, and any
AppView can rebuild its index from the firehose.
