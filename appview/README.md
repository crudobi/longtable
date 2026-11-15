# Longtable Hub AppView

The discovery hub for public Longtable recipes. It ingests public recipes
from the local ATProto PDS, **verifies them cryptographically before
indexing — repo-commit signature AND per-recipe device signature —**
and serves a small search API over a local SQLite index.

```
PDS firehose ──(filtered #commit events)──▶ reconcile(did)
                                                │
PLC directory ── DID doc (signing key) ──▶ verifyRepoCar(CAR, did, key)
                                                │  signature-valid repo state only
                                                ▼
                                      SQLite index + FTS5 ──▶ HTTP search API
```

## Ingest choice + filtering principle

We subscribe **directly to the PDS's own repo firehose**
(`com.atproto.sync.subscribeRepos` at `ws://<pds>/xrpc/com.atproto.sync.subscribeRepos`)
instead of running a Jetstream instance against a relay. On this local
testnet there is no relay in the path, and the PDS is the authoritative
source for its repos; Jetstream would add a second service, a second
subscription protocol, and a *pre-filtered, record-content-trusting* feed —
exactly the trust we do not want. Consuming the raw firehose keeps the
filtering decision here, in the consumer.

Filtering follows the **wantedCollections principle, applied at the
consumer**: for each `#commit` frame we inspect only its ops. Unless at
least one op path starts with `kitchen.longtable.recipe/` or
`kitchen.longtable.pubkey/`, the event is ignored entirely — no fetch, no
reconcile, no index write. Frames are decoded with `cborDecodeMulti` from
`@atproto/common` (a firehose frame is two concatenated CBOR objects:
header + body). A matching op triggers `reconcileRepo(did)` for the
commit's repo DID; reconciles are serialized through an internal queue and
the socket reconnects automatically after a drop.

## Verification model (verify-then-index)

`verify.mjs` is the only production path from the network to the index:

1. Resolve the author's DID document from the PLC directory
   (`GET $PLC_URL/<did>`) and extract the `#atproto` verification method's
   `publicKeyMultibase` as a `did:key` (`getSigningDidKey` from
   `@atproto/common`). Note: this testnet's PLC emits the legacy
   `EcdsaSecp256k1VerificationKey2019` shape — `publicKeyMultibase` is
   base58btc of the *raw* public key, with no multicodec prefix, which
   `@atproto/crypto` rejects as-is. `extractSigningDidKey` therefore
   re-wraps raw key bytes into a standard `did:key` using
   `formatDidKey`/`parseDidKey` from `@atproto/crypto` (format
   normalization only — the signature check itself is step 3, unchanged;
   a wrong normalization fails verification and indexes nothing).
2. Fetch the author's **full repo CAR** from the PDS
   (`GET $PDS_URL/xrpc/com.atproto.sync.getRepo?did=<did>`).
3. Verify it with **`verifyRepoCar(carBytes, did, signingKey)`** from
   `@atproto/repo`. That loads the commit, checks `commit.did === did`,
   verifies the commit signature against the DID-doc key via
   `@atproto/crypto`'s `verifySignature`, and walks the MST (diff against
   empty, all leaves required present). It returns the verified *creates*:
   the exact set of (collection, rkey, CID) that the signed repo state
   contains.
4. Read record bodies from the **same CAR** (walk the verified commit's
   MST: `MST.load` + `reachableLeaves()` + `getAndParseRecord` from
   `@atproto/repo`) and require every record's CID to be in the verified
   creates set before it can be diffed into the index.
5. Verify every recipe's **device signature** (`device-signature.mjs`,
   the same scheme as `src/public/publish.ts` and the independent
   verifier in `scripts/verify-public` — same canonical BLAKE2b-256 hash,
   same `longtable-pubkey:v1` / `longtable-recipe:v1` messages, same
   libsodium Ed25519 `verifyDetached`): load the author's
   `kitchen.longtable.pubkey/self` binding from the same verified CAR,
   check the binding signature and that the binding's `devicePublicKey`
   is exactly the key for its `deviceDid`, then check each recipe's
   `deviceDid` is the bound device and its `deviceSignature` verifies
   against the bound key over the recomputed canonical hash of the
   record as served. Records failing any check are dropped and counted
   (`rejected` + `signatureRejected`), never indexed.

Reconcile then diffs: upsert verified recipes present in the repo state,
delete indexed recipes for that DID that are no longer in it — including
recipes whose device signature stopped verifying (e.g. the author
rebound to a new device key). Stats keep
`{indexed, rejected, signatureRejected, lastReconcileAt}`; any
verification failure increments `rejected` and indexes nothing.

### What a hostile hub / ingest source can and cannot do

- **Cannot forge authorship.** Authorship is the repo a record was verified
  in, never a field inside the record. A record claiming someone else's DID
  in its content is indexed (if at all) under the DID whose signed repo
  actually contains it.
- **Cannot inject a record.** A firehose frame, a hub, or a direct
  `ingestClaim()` call only ever *triggers a reconcile*. The bytes that get
  indexed come from the PDS CAR after signature verification, and each
  record's CID must match the signed MST. `ingestClaim({did, collection,
  rkey, record})` computes the claimed record's CID with `cidForRecord`
  from `@atproto/repo` and indexes only if that exact CID is present in the
  verified repo state; otherwise `rejected` increments.
- **Cannot forge or alter recipe content.** The repo-commit signature is
  produced by the PDS, which holds the repo key — so a compromised PDS
  (or anything that writes straight into a repo) could get altered bytes
  into a "verified" repo state. The device signature stops that: the
  device key never leaves the author's phone, the AppView recomputes the
  canonical hash from the served bytes and verifies the detached
  signature against the bound key, and any mismatch is dropped and
  counted in `signatureRejected`. Rebinding to a new device key drops
  recipes signed by the old one.
- **Cannot resurrect or hide deletions.** Because reconcile diffs against
  the full verified state, a record deleted from the repo disappears from
  the index at the next reconcile of that DID, no matter what any
  intermediary claims.
- **Can cause work / delay.** A hostile source can trigger extra reconciles
  (a full-CAR fetch + verify per trigger) and can withhold events (the
  index goes stale until the next event for that DID or a manual
  reconcile). It cannot make the index *wrong* — only late. The trust
  anchors are the PLC-served DID document, the PDS CAR, and the author's
  device key (via the pubkey binding in the same CAR). A compromised PDS
  can withhold or delete records (availability), but cannot make the
  index contain a recipe the author's device never signed. One residual
  the AppView cannot close on its own: a hub serving its HTTP API
  dishonestly could return JSON that is not its index at all — clients
  must re-verify the served `deviceDid` / `deviceSignature` / `deviceKey`
  before displaying a recipe (client-side verification is the follow-up
  half of C2).

## Index

`node:sqlite` `DatabaseSync`. Table `recipes(uri PK, did, rkey, cid, name,
description, ingredients JSON, instructions JSON, prep, cook, yield, tags
JSON, images JSON, longtable_id, created_at, updated_at, device_did,
device_signature, device_key)` — the last three are the served signature
fields (pre-C2 index DBs gain them by migration; rows carry NULLs until
their next verified reconcile). Only device-verified rows are ever
diffed in. FTS5 virtual table `recipes_fts(uri UNINDEXED,
name, ingredients_text, tags_text)` is kept in sync on every upsert/delete.
**FTS5 is available** in this box's Node v24 `node:sqlite` (verified). If it
ever weren't, `RecipeIndex` falls back to LIKE-based search with identical
API semantics and reports `fts5: false` in `/stats`.

Search semantics: `q` is an FTS match over `name` (token-prefix, bm25
ranked). `ingredients` is AND semantics over `ingredients_text` — every
listed ingredient must match (token-prefix per ingredient token, so
`beets` matches the ingredient `"3 beets"`).

## HTTP API

| Route | Response |
| --- | --- |
| `GET /health` | `{ok: true}` |
| `GET /stats` | `{indexed, rejected, signatureRejected, lastReconcileAt, total, fts5}` |
| `GET /search?q=<name terms>` | `{results: [{uri, did, rkey, name, ingredients, tags, updatedAt, deviceDid, deviceSignature, deviceKey}]}` ranked by FTS rank |
| `GET /search?ingredients=egg,flour` | recipes containing **all** listed ingredients (AND) |
| `GET /search?q=...&ingredients=...` | both filters combined |
| `GET /recipe/:did/:rkey` | full indexed record JSON (incl. `images` blob refs, `deviceDid`, `deviceSignature`, `deviceKey`) or 404 |
| `GET /author/:did` | `{did, results: [...]}` — that author's indexed recipes, summaries carrying the same three signature fields |

Response contract (for clients verifying at read time): every per-recipe
object carries `deviceDid` (the author's Longtable device DID, a
`did:key:z...` Ed25519 DID, exactly as in the recipe record),
`deviceSignature` (standard padded base64 Ed25519 detached signature,
exactly as in the recipe record, over
`longtable-recipe:v1\n<accountDid>\n<longtableId>\n<hashHex>` where
`hashHex` is the BLAKE2b-256 hex of the canonical JSON array — see
`device-signature.mjs`), and `deviceKey` (standard padded base64 of the
32-byte Ed25519 device public key — byte-identical to the `devicePublicKey`
field of the author's `kitchen.longtable.pubkey/self` binding record, NOT
the did:key string and NOT hex). A client verifies by checking the
did:key derived from `deviceKey` equals `deviceDid`, recomputing the
canonical hash from the served record fields, and verifying the detached
signature against `deviceKey`.

DIDs in paths may be sent raw (`did:plc:...`) or URL-encoded.

## Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `APPVIEW_PORT` | `3210` | HTTP listen port |
| `APPVIEW_DB` | `./appview.db` | SQLite index path |
| `PDS_URL` | `http://localhost:2583` | PDS base URL (firehose + `getRepo`) |
| `PLC_URL` | `http://localhost:2582` | PLC directory base URL (DID docs) |

## Run

```sh
cd appview
npm install
tmux new -s lt-appview -d 'cd appview && npm start'
curl localhost:3210/health
```

## Tests

```sh
npm test          # vitest unit tests: FTS search, ingredient AND, reconcile
                  # diff/delete via a fake repo-state provider seam, and
                  # ingestClaim forgery rejection (test/*.appview-test.mjs —
                  # the suffix keeps the root package's CI vitest sweep,
                  # which runs without appview's node_modules, from trying
                  # to execute this subpackage's tests)
npm run test:e2e  # e2e/appview.e2e.mjs against the live local testnet:
                  # author publishes a device-signed recipe (binding first)
                  # -> searchable (latency printed); /recipe/ + /search
                  # carry deviceDid/deviceSignature/deviceKey; attacker
                  # publishes same name, signed under their OWN binding
                  # -> both, own DIDs; forged ingestClaim in the author's
                  # name -> rejected, never searchable; author publishes
                  # a TAMPERED record (genuine signature, altered content)
                  # -> dropped at ingest, counted in signatureRejected,
                  # never searchable, 404 on /recipe/; author deletes
                  # -> disappears.
                  # Needs the testnet up + accounts at
                  # <LT_ROOT>/ops/longtable-atproto/accounts.json
                  # (or PDS_URL/PLC_URL/ACCOUNTS_FILE for an isolated
                  # testnet on other ports).
```

## Layout

- `index.mjs` — entry point (env, listen, firehose, signals)
- `server.mjs` — `createAppView()` factory + HTTP API
- `ingest.mjs` — firehose subscription, filtering, `reconcileRepo`,
  `ingestClaim` forge-test hook
- `verify.mjs` — DID-doc key extraction, CAR fetch, `verifyRepoCar`
- `device-signature.mjs` — pubkey-binding + per-recipe device-signature
  verification (canonical hash, binding/recipe messages, did:key)
- `db.mjs` — `RecipeIndex` (SQLite + FTS5)
- `test/` — vitest unit tests · `e2e/` — live-testnet e2e
