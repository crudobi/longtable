# Longtable telemetry audit

**Policy: no telemetry, no analytics, no phone-home — anywhere.** Not in
the app, not in the hub. This file lists every outbound connection each
component makes in normal operation. Anything beyond this list is a bug;
report it.

## The app (client)

Outbound connections happen only for actions the user initiated or
state the user asked to keep in sync:

| Destination | When | What crosses |
|---|---|---|
| Hub signaling (wss) — every hub in the user's hub list | App running with shares/friends | Room names + WebRTC offers/answers. Room names are random or derived hashes; no recipe content, no titles. |
| Peers directly (WebRTC/DTLS) | Syncing a shared recipe or friend channel | Recipe shares: Yjs updates. Friend channels: ciphertext only (secretbox/sealed-box); the channel password never leaves the device. |
| Hub TURN/STUN | WebRTC setup when direct paths fail | Encrypted WebRTC packets relayed verbatim. TURN credentials from the user's hub config. |
| PDS (XRPC https) | User signs in, publishes/unpublishes a public recipe, or saves a copy of a public recipe with photos | Only public-recipe records + the pubkey binding, over the user's own account session. Private and friends-only recipes are never sent. |
| AppView (https) | User opens Discover / searches | The search query text only. |

The app contains no analytics SDKs, no crash reporters, no update
checkers, and loads no remote fonts, scripts, or images (the web build
is fully self-contained). Local cooking works with zero network.

## The hub

| Component | Outbound connections |
|---|---|
| web server | None. Serves static files only. |
| signaling | None. Accepts wss connections; relays rendezvous messages between connected peers. |
| coturn | None initiated. Relays UDP/TCP media between peers that ask. |
| AppView | The configured PDS/PLC **only**: firehose subscription to the PDS (`com.atproto.sync.subscribeRepos`), repo fetches for signature verification (`com.atproto.sync.getRepo`), DID resolution via the configured PLC, blob fetches for the media cache (`com.atproto.sync.getBlob`). |
| managed PDS (testnet) | The local PLC only (`didPlcUrl` is the hub's own PLC). Handle/DID resolution is rewritten to the local services by the testnet harness; it never contacts plc.directory or bsky.social. |
| supervisor | None. Spawns and watches the children above. |

Inbound-only services (the app, search, sync) accept connections; they
never initiate any beyond the table above.

## How this is verified

`e2e/proof-hubfail.mjs` runs a scripted two-device session against two
packaged hubs while `tcpdump` records every packet leaving the device
host; the destination set is compared against exactly the endpoints in
the table above (plus emulator infrastructure: DNS on the virtual
gateway and the local test harness itself, both enumerated in the proof
output). The audit is re-run per release; a new destination fails it.
