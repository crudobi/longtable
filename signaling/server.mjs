#!/usr/bin/env node
/**
 * Longtable WebRTC signaling server — Phase 1 P2P.
 *
 * Speaks the y-webrtc signaling protocol (see PROTOCOL.md): JSON-over-WebSocket
 * subscribe/unsubscribe/publish + ping/pong, routed by topic (room name).
 *
 * SIGNaling ONLY:
 *  - no document storage, no persistence (topics exist only as in-memory
 *    subscriber sets; empty topics are dropped)
 *  - no payload logging — publish payloads are forwarded opaquely and never
 *    inspected (rooms with a password are end-to-end encrypted anyway)
 *  - aggregate counters only (connections, publishes), off unless SIGNAL_STATS=1
 *  - abuse limits (the server is otherwise an open relay): at most 50
 *    concurrent connections per source IP, 100 subscribed topics per
 *    connection, 200 messages per 10s per connection, and 5000 messages
 *    per 10s per source IP in aggregate (M13 — the per-connection cap
 *    alone still allowed 50 conns x 200 msgs = 1000 msgs/s from one IP).
 *    Excess is dropped, not disconnected — y-webrtc clients are nowhere
 *    near these numbers; they only bite floods.
 *  - no presence leakage (M13): publish relays carry no subscriber
 *    count, and /health reports topic/connection counts only to
 *    loopback callers (local health checks / tests); anyone else gets
 *    {ok:true} only, so a remote prober cannot enumerate live rooms.
 *
 * Authentication (accepted risk — S18, documented, not built here):
 * the server has NO authentication: anyone who can reach the port can
 * subscribe/publish to any topic, inject SDP/ICE, and probe presence.
 * That is the design the hub ships with until rooms are bound to the
 * invite's hub credential (or a per-hub token is checked on upgrade) —
 * see PROTOCOL.md "Authentication (accepted risk)". Room payloads are
 * end-to-end encrypted, so the exposure is handshake/availability
 * abuse, not content compromise. Run the server behind the hub on a
 * trusted network (or localhost) and firewall the port.
 *  - malformed messages (bad JSON, non-object payloads, non-array
 *    `topics`) are dropped and counted; a single bad message can never
 *    kill the process (S4 — the message handler is guarded and the
 *    subscribe/unsubscribe branches require an array)
 *
 * Later this becomes the hub's signaling component; the protocol stays
 * y-webrtc-compatible so any spec-compliant client works.
 */

import { WebSocketServer } from 'ws'
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.PORT || 4444)
// TLS cert/key for wss://. The app's WebView is https://localhost, and browsers
// block insecure ws:// from secure contexts — so the signaling server must speak
// wss://. Defaults to the e2e fixture cert (SAN IP:10.0.2.2); override via env.
//
// Sec L15 — fail closed, never silently downgrade to ws://. The old
// code served plain ws whenever the cert files were absent, so a
// typo'd path or a missing fixture silently dropped the whole room
// to plaintext (and the default was the fixture cert shared across
// machines). Now: explicitly-configured TLS paths (TLS_CERT/TLS_KEY)
// must exist or the process exits instead of starting; the fixture
// default must exist too; plaintext needs an EXPLICIT opt-out
// (SIGNAL_PLAINTEXT=1, tests + loopback-only dev). The hub always
// passes its own minted cert paths (hub.mjs ensureTls), so hub-run
// signaling never hits any of these branches.
const LT_ROOT =
  process.env.LT_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const FIXTURE_CERTS =
  process.env.FIXTURE_CERTS ?? path.join(LT_ROOT, 'tools/android-emu/fixture-certs')
const TLS_CERT = process.env.TLS_CERT || path.join(FIXTURE_CERTS, 'server.crt')
const TLS_KEY = process.env.TLS_KEY || path.join(FIXTURE_CERTS, 'server.key')
const TLS_CONFIGURED = Boolean(process.env.TLS_CERT || process.env.TLS_KEY)
const PLAINTEXT = process.env.SIGNAL_PLAINTEXT === '1'
if (!PLAINTEXT && (!fs.existsSync(TLS_CERT) || !fs.existsSync(TLS_KEY))) {
  // Synchronous write: process.exit(1) below can truncate an async
  // console.error to a pipe, and a fail-closed refusal nobody sees
  // is a silent downgrade of a different kind.
  fs.writeSync(
    2,
    `[signal] TLS certificate not found: ${TLS_CERT} / ${TLS_KEY}\n` +
      (TLS_CONFIGURED
        ? 'TLS_CERT/TLS_KEY are set but the files are missing — refusing to serve plain ws://. Fix the paths.\n'
        : 'No TLS certificate found (the e2e fixture cert is missing) — refusing to serve plain ws://. Set TLS_CERT/TLS_KEY to a real cert, or SIGNAL_PLAINTEXT=1 for loopback-only dev/test use.\n'),
  )
  process.exit(1)
}
if (PLAINTEXT) {
  console.warn('[signal] SIGNAL_PLAINTEXT=1 — serving plain ws:// (loopback-only dev/test use, never production)')
}
const MAX_PAYLOAD = 1 << 20 // 1 MiB — signaling frames (SDP/ICE) are tiny
const MAX_TOPIC_LEN = 256
const MAX_CONNS_PER_IP = 50
const MAX_TOPICS_PER_CONN = 100
const RATE_LIMIT_MSGS = 200
const RATE_LIMIT_WINDOW_MS = 10_000
// M13: aggregate per-IP budget (messages per window across ALL
// connections from one source IP). Overridable for tests via
// SIGNAL_MAX_MSGS_PER_IP; the production default is 5000/10s.
const MAX_MSGS_PER_IP = Number(process.env.SIGNAL_MAX_MSGS_PER_IP || 5000)
const IP_RATE_WINDOW_MS = 10_000
const PING_INTERVAL = 30000
const STATS = process.env.SIGNAL_STATS === '1'

const WS_OPEN = 1

/** topic -> Set<WebSocket> */
const topics = new Map()

let statConns = 0
let statPublishes = 0
let statRateDrops = 0
let statTopicDrops = 0
let statMalformedDrops = 0
let statIpRateDrops = 0
/** source IP -> { start, count } for the aggregate budget (M13) */
const msgsByIp = new Map()
/** source IP -> live connection count (for MAX_CONNS_PER_IP) */
const connsByIp = new Map()

/**
 * @param {import('ws').WebSocket} conn
 * @param {object} msg
 */
const send = (conn, msg) => {
  if (conn.readyState !== WS_OPEN) {
    return
  }
  try {
    conn.send(JSON.stringify(msg))
  } catch {
    try {
      conn.close()
    } catch {
      /* already gone */
    }
  }
}

/** @param {string} t */
const validTopic = t => typeof t === 'string' && t.length > 0 && t.length <= MAX_TOPIC_LEN

/**
 * @param {import('ws').WebSocket} conn
 */
const onConnection = (conn, req) => {
  const ip = req?.socket?.remoteAddress ?? 'unknown'
  const ipCount = connsByIp.get(ip) ?? 0
  if (ipCount >= MAX_CONNS_PER_IP) {
    console.log(`[signal] connection cap hit for ${ip} (${MAX_CONNS_PER_IP}); rejecting`)
    try {
      conn.close(1013, 'too many connections from this address')
    } catch {
      /* already gone */
    }
    return
  }
  connsByIp.set(ip, ipCount + 1)
  conn.on('close', () => {
    const n = (connsByIp.get(ip) ?? 1) - 1
    if (n <= 0) {
      connsByIp.delete(ip)
    } else {
      connsByIp.set(ip, n)
    }
  })

  /** @type {Set<string>} */
  const subscribed = new Set()
  let alive = true
  statConns++

  // Fixed-window rate limit: messages past the cap are dropped (and
  // counted), the connection stays up.
  let rateWindowStart = Date.now()
  let rateCount = 0

  conn.on('message', raw => {
    // Defense in depth (S4): no single malformed message may kill the
    // process. The per-branch guards below drop bad shapes; this catch
    // is the backstop for anything they miss. The message is dropped
    // and counted; the connection stays up.
    try {
    // M13 aggregate budget: all connections from one IP share it, so
    // opening 50 connections cannot multiply the flood capacity 50x.
    // Checked before parsing — even malformed floods count.
    const ipNow = Date.now()
    const ipWindow = msgsByIp.get(ip)
    if (!ipWindow || ipNow - ipWindow.start >= IP_RATE_WINDOW_MS) {
      msgsByIp.set(ip, { start: ipNow, count: 1 })
    } else if (++ipWindow.count > MAX_MSGS_PER_IP) {
      statIpRateDrops++
      return
    }
    const now = Date.now()
    if (now - rateWindowStart >= RATE_LIMIT_WINDOW_MS) {
      rateWindowStart = now
      rateCount = 0
    }
    if (++rateCount > RATE_LIMIT_MSGS) {
      statRateDrops++
      return
    }
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return // malformed JSON: drop
    }
    if (msg === null || typeof msg !== 'object' || typeof msg.type !== 'string') {
      return
    }
    switch (msg.type) {
      case 'subscribe':
        if (process.env.SIGNAL_DEBUG) console.log('[signal] subscribe', msg.topics);
        if (!Array.isArray(msg.topics)) {
          statMalformedDrops++
          break
        }
        for (const t of msg.topics) {
          if (!validTopic(t)) {
            continue
          }
          if (!subscribed.has(t) && subscribed.size >= MAX_TOPICS_PER_CONN) {
            statTopicDrops++
            continue
          }
          let set = topics.get(t)
          if (set === undefined) {
            set = new Set()
            topics.set(t, set)
          }
          set.add(conn)
          subscribed.add(t)
        }
        break
      case 'unsubscribe':
        if (!Array.isArray(msg.topics)) {
          statMalformedDrops++
          break
        }
        for (const t of msg.topics) {
          const set = topics.get(t)
          if (set !== undefined) {
            set.delete(conn)
            if (set.size === 0) {
              topics.delete(t)
            }
          }
          subscribed.delete(t)
        }
        break
      case 'publish': {
        // Sec L20: SIGNAL_DEBUG logs topic + byte length ONLY. The
        // old line stringified the first 200 chars of the payload —
        // publish payloads are handshake material (SDP/ICE) and room
        // traffic the server is supposed to forward opaquely; even a
        // prefix of it in a log is content the server should not
        // retain. (PROTOCOL.md already promised "no payload logging"
        // — this line was the exception to that promise.)
        if (process.env.SIGNAL_DEBUG) {
          const dataJson = JSON.stringify(msg.data ?? null)
          console.log('[signal] publish', msg.topic, 'bytes=', dataJson === undefined ? 0 : Buffer.byteLength(dataJson))
        }
        if (!validTopic(msg.topic)) {
          break
        }
        const receivers = topics.get(msg.topic)
        if (receivers !== undefined && receivers.size > 0) {
          statPublishes++
          // Payload is forwarded opaquely — never inspected or logged.
          // Sender echo is suppressed (clients ignore their own peerId anyway).
          // M13: no subscriber count — the relay must not tell every
          // publisher how many peers are in the room (presence leak).
          const out = { type: 'publish', topic: msg.topic, data: msg.data }
          for (const r of receivers) {
            if (r !== conn) {
              send(r, out)
            }
          }
        }
        break
      }
      case 'ping':
        send(conn, { type: 'pong' })
        break
      // unknown types: ignore
    }
    } catch {
      statMalformedDrops++
    }
  })

  conn.on('pong', () => {
    alive = true
  })

  const drop = () => {
    for (const t of subscribed) {
      const set = topics.get(t)
      if (set !== undefined) {
        set.delete(conn)
        if (set.size === 0) {
          topics.delete(t)
        }
      }
    }
    subscribed.clear()
  }
  conn.on('close', drop)
  conn.on('error', () => {})

  // Dead-socket watchdog (mirrors the reference server): WS-level ping every
  // 30s; terminate if the peer never pongs.
  const watchdog = setInterval(() => {
    if (!alive) {
      clearInterval(watchdog)
      try {
        conn.terminate()
      } catch {
        /* already gone */
      }
      return
    }
    alive = false
    try {
      conn.ping()
    } catch {
      clearInterval(watchdog)
    }
  }, PING_INTERVAL)
  conn.on('close', () => clearInterval(watchdog))
}

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD })
wss.on('connection', onConnection)

/**
 * M13: /health detail is loopback-only. Local health checks (the hub,
 * e2e proofs, an operator on the box) still see topic/connection
 * counts; a remote caller — the server listens on all interfaces —
 * gets {ok:true} and nothing enumerable.
 */
const isLoopback = req => {
  const addr = req?.socket?.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

const requestHandler = (req, res) => {
  if (req.url === '/health') {
    // statConns is cumulative (total connections ever); the live
    // count is the sum over connsByIp.
    const liveConnections = [...connsByIp.values()].reduce((a, b) => a + b, 0)
    const body = JSON.stringify(
      isLoopback(req)
        ? { ok: true, topics: topics.size, connections: liveConnections }
        : { ok: true },
    )
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(body)
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('okay')
}
// Sec L15: the existence check above already exited when no cert is
// available and plaintext was not explicitly requested — useTls is
// therefore just "not plaintext", never a silent downgrade.
const useTls = !PLAINTEXT
const server = useTls
  ? https.createServer(
      { cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) },
      requestHandler,
    )
  : http.createServer(requestHandler)

server.on('upgrade', (req, socket, head) => {
  // Auth hook point for the hub later; currently open (LAN/P2P use).
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req))
})

server.listen(PORT, () => {
  console.log(
    `longtable signaling server listening on :${PORT} (${useTls ? 'wss' : 'ws'})`,
  )
})

if (STATS) {
  setInterval(() => {
    console.log(`stats: topics=${topics.size} connections=${statConns} publishes=${statPublishes} rateDrops=${statRateDrops} ipRateDrops=${statIpRateDrops} topicDrops=${statTopicDrops} malformedDrops=${statMalformedDrops}`)
  }, 5000).unref()
}
