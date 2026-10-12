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
| `publish` | relay a client's publish to subscribers of the topic | `{type:'publish', topic, data, clients:N}` where `N` = subscriber count at relay time (the reference server annotates this; clients ignore it) |
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
- **Signaling only**: store nothing about documents, log no payloads
  (not even their size per message — only aggregate counters, off by
  default). Room `password` payloads are end-to-end encrypted; the server
  treats them as opaque base64.
- Validate defensively: topics must be non-empty strings (≤256 chars);
  malformed JSON is dropped; unknown message types are ignored.

## Anti-centralization note

This protocol is exactly what the public `yjs.dev` signaling servers speak.
We run our own (`signaling/server.mjs`, later the hub's signaling
component) and never point clients at public servers — but any
spec-compliant server works, which keeps the P2P layer replaceable and the
hub killable per the Longtable principles.
