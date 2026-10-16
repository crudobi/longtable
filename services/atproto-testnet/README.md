# Longtable ATProto testnet (local PLC + PDS)

A long-running, fully local ATProto network for Longtable Phase 3
(public publishing). It serves two roles:

- **Hub-managed PDS option** — a real Personal Data Server that a Longtable
  hub can run for its users, instead of depending on bsky.social.
- **Proof environment** — the place where public publishing, DID binding
  (`kitchen.longtable.pubkey`), and recipe records
  (`kitchen.longtable.recipe`) are proven end-to-end before anything
  touches the real network.

## What runs

Bluesky's own `@atproto/dev-env` (pinned: `0.3.215`) —
`TestNetworkNoAppView.create({ plc: { port: 2582 }, pds: { port: 2583 } })`:

| Service | URL | Implementation |
| --- | --- | --- |
| PLC | http://localhost:2582 | Real PLC server (`@did-plc/server`, in-memory mock DB) |
| PDS | http://localhost:2583 | Real PDS (`@atproto/pds`, SQLite + disk blobstore in a tmp data dir) |

No AppView is started. There is **no traffic to plc.directory or
bsky.social**: the PDS is created with `didPlcUrl` pointing at the local
PLC, and dev-env rewrites handle/DID resolution inside the PDS to the
local services. Repos are real and signed; `createSession`, `putRecord`,
`getRecord`, `deleteRecord`, `listRecords`, and `uploadBlob` are the real
XRPC methods.

No Postgres or Redis is needed for this configuration — those are only
required by the AppView (bsky) and ozone services, which are not started.

## Ephemerality — re-seed after every restart

The testnet is **ephemeral**. The PLC database is in-memory and the PDS
data directory is a fresh tmp directory per boot, so **every restart
mints brand-new DIDs and wipes all accounts and records**. After each
start, re-run the seed:

```sh
npm run seed
```

## Run it

Long-running, in a named tmux session on devbox:

```sh
cd /home/devbox/code/longtable/services/atproto-testnet
npm install
tmux new -s lt-atproto -d 'node start.mjs'   # or: npm start in the session
```

Health check:

```sh
curl http://localhost:2583/xrpc/_health
```

Seed the proof accounts:

```sh
npm run seed
```

Smoke test (login as author → putRecord → getRecord → listRecords →
deleteRecord for a `kitchen.longtable.recipe`):

```sh
npm run smoke
```

Stop it with `tmux kill-session -t lt-atproto`, or Ctrl-C / SIGTERM —
`start.mjs` closes the network cleanly on SIGINT/SIGTERM.

## Seeded accounts

`npm run seed` creates two accounts on the local PDS and writes the
result to **`/home/devbox/ops/longtable-atproto/accounts.json`**:

```json
{
  "author":   { "handle": "olga.test",    "password": "<generated at seed time>", "did": "did:plc:..." },
  "attacker": { "handle": "mallory.test", "password": "<generated at seed time>", "did": "did:plc:..." }
}
```

The password is **generated fresh by each seed run** and printed once
in the seed output (set `LT_SEED_PASSWORD` to choose one instead).
There is no shared default password — treat `accounts.json` as a
secret.

(emails: `olga@test.local` / `mallory@test.local`.) The seed is idempotent
within one testnet lifetime: if an account already exists it logs in
instead and refreshes the DID in the file. The DIDs in the file are only
valid until the next testnet restart (see ephemerality above).

## Handles

Handles under `.test` (a PDS `serviceHandleDomains` entry in dev-env)
resolve **only inside this local network**. `olga.test` is not a DNS name
and means nothing outside this testnet; likewise `did:plc:...` DIDs
minted here exist only in the local PLC.

## TLS proxy for emulator/app access (tls-proxy.mjs)

The Longtable app runs on an https://localhost origin (Capacitor), so from
the Android emulator it cannot fetch the plain-http PDS/AppView (mixed
content + Android cleartext policy). `tls-proxy.mjs` terminates TLS with
the e2e fixture CA server cert (SAN IP:10.0.2.2, already in the emulators

## TLS proxy for emulator/app access (tls-proxy.mjs)

The Longtable app runs on an https://localhost origin (Capacitor), so from
the Android emulator it cannot fetch the plain-http PDS/AppView (mixed
content + Android cleartext policy). `tls-proxy.mjs` terminates TLS with
the e2e fixture CA server cert (SAN IP:10.0.2.2, already in the emulators'
user trust store) and forwards to the local http services:

    node tls-proxy.mjs 2584 http://localhost:2583   # PDS  -> https://10.0.2.2:2584
    node tls-proxy.mjs 3211 http://localhost:3210   # AppView -> https://10.0.2.2:3211

Point the app's publish settings at https://10.0.2.2:2584 and its AppView
URL at https://10.0.2.2:3211 when testing on the emulator. Host-side tools
keep using the plain http URLs. (e2e/proof-public.mjs depends on both
proxies running.)
