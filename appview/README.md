# Longtable Hub AppView

The discovery hub for public Longtable recipes. It ingests public recipes
from the local ATProto PDS, **verifies them cryptographically before
indexing**, and serves a small search API over a local SQLite index.

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

Reconcile then diffs: upsert recipes present in the verified state, delete
indexed recipes for that DID that are no longer in it. Stats keep
`{indexed, rejected, lastReconcileAt}`; any verification failure increments
`rejected` and indexes nothing.

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
- **Cannot resurrect or hide deletions.** Because reconcile diffs against
  the full verified state, a record deleted from the repo disappears from
  the index at the next reconcile of that DID, no matter what any
  intermediary claims.
- **Can cause work / delay.** A hostile source can trigger extra reconciles
  (a full-CAR fetch + verify per trigger) and can withhold events (the
  index goes stale until the next event for that DID or a manual
  reconcile). It cannot make the index *wrong* — only late. The trust
  anchors are the PLC-served DID document and the PDS CAR; if those two are
  themselves compromised for a DID, that DID's key is compromised and no
  AppView-side check can save it (key rotation via PLC is the remedy).

## Index

`node:sqlite` `DatabaseSync`. Table `recipes(uri PK, did, rkey, cid, name,
description, ingredients JSON, instructions JSON, prep, cook, yield, tags
JSON, images JSON, longtable_id, created_at, updated_at)`, diffed in from
verified repo state only. FTS5 virtual table `recipes_fts(uri UNINDEXED,
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
| `GET /stats` | `{indexed, rejected, lastReconcileAt, total, fts5}` |
| `GET /search?q=<name terms>` | `{results: [{uri, did, rkey, name, ingredients, tags, updatedAt}]}` ranked by FTS rank |
| `GET /search?ingredients=egg,flour` | recipes containing **all** listed ingredients (AND) |
| `GET /search?q=...&ingredients=...` | both filters combined |
| `GET /recipe/:did/:rkey` | full indexed record JSON (incl. `images` blob refs) or 404 |
| `GET /author/:did` | `{did, results: [...]}` — that author's indexed recipes |

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
tmux new -s lt-appview -d 'cd /home/devbox/code/longtable/appview && npm start'
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
                  # author publishes -> searchable (latency printed);
                  # attacker publishes same name -> both, own DIDs;
                  # forged ingestClaim in the author's name -> rejected,
                  # never searchable; author deletes -> disappears.
                  # Needs the testnet up + accounts at
                  # /home/devbox/ops/longtable-atproto/accounts.json
```

## Layout

- `index.mjs` — entry point (env, listen, firehose, signals)
- `server.mjs` — `createAppView()` factory + HTTP API
- `ingest.mjs` — firehose subscription, filtering, `reconcileRepo`,
  `ingestClaim` forge-test hook
- `verify.mjs` — DID-doc key extraction, CAR fetch, `verifyRepoCar`
- `db.mjs` — `RecipeIndex` (SQLite + FTS5)
- `test/` — vitest unit tests · `e2e/` — live-testnet e2e
