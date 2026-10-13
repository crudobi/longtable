# Example: a third-party client

This is a complete, runnable third-party Longtable client (~250 lines,
one file). It was written from [`docs/public-protocol.md`](../../docs/public-protocol.md)
alone and deliberately uses **none** of the Longtable app's code — only
official ATProto libraries (`@atproto/repo`, `@atproto/common`,
`@atproto/crypto`) and libsodium.

It implements the protocol's read + verify flow:

1. Search an AppView for a public recipe (a hint, not proof).
2. Resolve the author's DID document.
3. Fetch the `kitchen.longtable.pubkey` binding and the
   `kitchen.longtable.recipe` record from the author's own PDS.
4. Verify the repo export's commit signature against the DID-document
   key, and that the recipe's CID sits inside the verified repo.
5. Verify the device-key binding signature.
6. Verify the recipe's device signature over its canonical hash.

If every step passes, the recipe is genuinely the author's — no trust
in the AppView, the hub, or this repository required.

## Run it

```sh
npm install
APPVIEW_URL=http://localhost:3210 \
PLC_URL=http://localhost:2582 \
node read-recipe.mjs soup
```

(With the repo's local testnet + hub running, those are the AppView's
direct port and the testnet PLC. `PDS_URL` overrides the PDS endpoint
from the DID document when needed.) Or pin a record directly:

```sh
node read-recipe.mjs --did did:plc:… --rkey <longtableId>
```

Exit code 0 = every verification passed; the recipe is printed at the
end. For a deeper audit (repo contents listing + forgery self-test),
see `scripts/verify-public/` in the repository root.
