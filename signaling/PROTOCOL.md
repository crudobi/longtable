# y-webrtc signaling protocol

Researched 2026-10-11 from `y-webrtc` **10.3.0** npm source (`src/y-webrtc.js`,
`src/crypto.js`, reference server `bin/server.js`, client transport
`lib0/websocket.js`). The protocol below is version-stable across y-webrtc 10.x.

## Transport

- Plain WebSocket. All frames are **JSON text** (`JSON.stringify` on send,
  `JSON.parse` on receive — see `lib0/websocket.js`). No binary frames are
  used by the client. The client (`WebsocketClient`) reconnects with
  exponential backoff (base 1200ms, cap 2500ms) and force-closes the socket
  if no message arrives within 30s (`messageReconnectTimeout`).
- A room name is the **topic**. Signaling is per-topic pub/sub; the server
  never interprets what rooms mean.

## Client → server

| message | when sent | shape |
|---|---|---|
| `subscribe` | on WS `connect` (all current room names); also per-room when a room is created while already connected (`announceSignalingInfo`) | `{type:'subscribe', topics:[roomName,…]}` |
| `unsubscribe` | when a `Room` is destroyed (`Room.destroy`) | `{type:'unsubscribe', topics:[roomName]}` |
| `publish` | peer discovery + WebRTC handshake, see below | `{type:'publish', topic:roomName, data}` |
| `ping` | keepalive every 15s (`messageReconnectTimeout/2`) | `{type:'ping'}` |

`data` (the publish payload) is **opaque to the server** and one of:

- a JSON object `{type:'announce'|'signal', from:peerId, to?:peerId, token?, signal?}`
  (see "Inner payload types"), or
- a base64 **string** when the room was created with a `password`
  (`room.key` set): the JSON above, AES-GCM encrypted client-side
  (`src/crypto.js`). The server cannot read it and must not try.

## Server → client

| message | when sent | shape |
|---|---|---|
| `publish` | relay a client's publish to subscribers of the topic | `{type:'publish', topic, data}` — no subscriber count. (The reference server annotates `clients:N`; our server used to as well, but the count is a presence leak — every publisher learned how many peers were in the room — so it was removed. Clients ignore it.) |
| `pong` | reply to `ping` | `{type:'pong'}` |

The reference server relays to **all** subscribers including the sender;
clients ignore their own messages (`data.from === own peerId`), so relaying
back to the sender is harmless but wasteful. Our server (`server.mjs`)
suppresses the sender echo; clients cannot tell the difference.

## Inner payload types (opaque to the server, documented for completeness)

- `{type:'announce', from:peerId}` — "I joined this room; open a WebRTC
  connection to me." A receiving peer creates a `WebrtcConn` as **initiator**
  (if under `maxConns`) and starts the handshake. `peerId` is a random
  per-room id (`room.peerId`), not a user id.
- `{type:'signal', from, to, token, signal}` — `simple-peer` handshake:
  SDP offer/answer and ICE candidates. `to` addresses one peer. `token`
  (`glareToken`) resolves offer glare: the peer with the larger token
  answers, the smaller one backs off.

Client-side receive filters (server does **not** need to implement these,
but must not break them):

- ignore if `data.from === own peerId`
- ignore if `data.to` is set and `!== own peerId`
- ignore if `data.from` is already reachable via `BroadcastChannel`
  (same-browser tabs prefer BC; cross-browser/cross-device uses WebRTC)

## Handshake flow (one room)

1. WS connects → client sends `subscribe` with all room names.
2. Client publishes `{type:'announce', from:peerId}` on the room topic.
3. Each other subscriber creates an initiator `WebrtcConn` and publishes an
   SDP **offer** back (`{type:'signal', to:announcer, signal:{type:'offer'…}}`).
4. Offer/answer/ICE trickle through `publish`/`signal` until the
   RTCDataChannel opens.
5. From then on **all Yjs traffic** (y-protocols `messageSync`,
   `messageAwareness`) flows over the WebRTC datachannel peer-to-peer —
   **never through the signaling server again**. The server only ever sees
   discovery + handshake signaling.

## Server obligations (what `server.mjs` implements)

- Route `publish` by `topic` to current subscribers. No persistence of
  topics beyond subscriber sets in memory; empty topics are dropped.
- Answer `ping` with `pong`; drop dead sockets (WS protocol ping/pong
  watchdog, 30s, same as the reference).
- **Signaling only**: store nothing about documents, log no payload
  content — under `SIGNAL_DEBUG` the server logs the topic + byte
  length only (Sec L20), never any payload bytes; otherwise only
  aggregate counters, off by default. Room `password` payloads are
  end-to-end encrypted; the server treats them as opaque base64.
- Validate defensively: topics must be an array of non-empty strings
  (≤256 chars); malformed messages (bad JSON, non-object payloads,
  non-array `topics`) are dropped and counted, and can never crash the
  server; unknown message types are ignored.
- Abuse limits: at most 50 concurrent connections per source IP, 100
  subscribed topics per connection, 200 messages per 10 s per
  connection, and 5000 messages per 10 s per source IP in aggregate
  across all its connections (so opening 50 connections cannot
  multiply the flood capacity 50x). Excess is dropped, not
  disconnected.
- Presence: publish relays carry no subscriber count, and `/health`
  reports topic/connection counts to loopback callers only — a remote
  caller gets `{ok:true}` and nothing enumerable.

## Authentication (accepted risk — S18)

The server has **no authentication**: anyone who can reach the port
can subscribe/publish to any topic, inject SDP/ICE, and probe
presence. This is accepted, not overlooked, for the following reasons:

- Room payloads are end-to-end encrypted (room `password` → AES-GCM
  client-side; friend shelf traffic is sealed-box on top of that), so
  an unauthenticated peer cannot read content — only handshake and
  availability abuse is in scope (joining rooms, injecting handshake
  messages, enumerating live topics where the server still answers).
- The intended deployment is the hub on a trusted network (or
  localhost) with the port firewalled; the hub, not the open internet,
  is the audience. The review's stated fix is a design decision, not a
  patch: bind rooms to the invite's hub credential, or check a
  per-hub token on WebSocket upgrade. Until that design lands, adding
  a password or token here would be a new auth system with its own
  enrollment, rotation, and revocation surface — larger than the risk
  it closes on a trusted-network relay.
- The residual is bounded by the abuse limits above (per-IP connection
  and aggregate message budgets) and by the presence gating (no
  subscriber counts in relays; `/health` counts are loopback-only).

If the signaling port is ever exposed beyond a trusted network, this
acceptance must be revisited first — that exposure changes the threat
model the acceptance rests on.

## Hub fan-out (accepted risk — Sec L2)

A client announces and subscribes on **every** hub in its hub list —
signaling and TURN alike — not just one. This is deliberate E8
failover: if any hub dies, the others are already carrying discovery
and relay for every live room, so there is no failover delay and no
reconfiguration at the moment of failure. Narrowing rendezvous to
"the invite's hub + the active hub" would reintroduce exactly the
single point of failure E8 exists to remove.

Privacy cost, stated plainly: every hub in the list learns presence
metadata for every room — which rooms are live, when peers join and
leave, handshake timing, and TURN relay volume — even for rooms that
end up connecting through another hub. What a hub does **not** learn
is content: room payloads are end-to-end encrypted (room `password`
→ AES-GCM client-side; friend shelf traffic is sealed-box on top of
that), and the TURN relay forwards encrypted packets only, so a hub
sees peer IPs and packet sizes, never plaintext. The residual is
bounded the same way as S18 above — trusted-network deployment,
firewalled signaling port — and by the per-IP aggregate message
budget (M13). If a deployment cannot accept every hub learning
every room's presence, it must narrow the hub list itself (fewer
hubs, less metadata spread); the fan-out is not configurable per
room, by design.

## TLS (fail-closed — Sec L15)

The server speaks `wss://`. `TLS_CERT`/`TLS_KEY` must point at
existing files or the process refuses to start — a missing cert is
a startup error, never a silent downgrade to `ws://` (the old
behavior). Plaintext needs an explicit opt-out,
`SIGNAL_PLAINTEXT=1`, for loopback-only dev/test use. The hub always
passes its own minted cert paths, so hub-run signaling is always
`wss://`; the shared e2e fixture cert is only ever a dev default,
never a production identity.

## Anti-centralization note

This protocol is exactly what the public `yjs.dev` signaling servers speak.
We run our own (`signaling/server.mjs`, later the hub's signaling
component) and never point clients at public servers — but any
spec-compliant server works, which keeps the P2P layer replaceable and the
hub killable per the Longtable principles.
