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
 *    connection, and 200 messages per 10s per connection (excess
 *    dropped, not disconnected — y-webrtc clients are nowhere near
 *    these numbers; they only bite floods)
 *
 * Later this becomes the hub's signaling component; the protocol stays
 * y-webrtc-compatible so any spec-compliant client works.
 */

import { WebSocketServer } from 'ws'
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'

const PORT = Number(process.env.PORT || 4444)
// TLS cert/key for wss://. The app's WebView is https://localhost, and browsers
// block insecure ws:// from secure contexts — so the signaling server must speak
// wss://. Defaults to the e2e fixture cert (SAN IP:10.0.2.2); override via env.
const TLS_CERT = process.env.TLS_CERT || '/home/devbox/tools/android-emu/fixture-certs/server.crt'
const TLS_KEY = process.env.TLS_KEY || '/home/devbox/tools/android-emu/fixture-certs/server.key'
const MAX_PAYLOAD = 1 << 20 // 1 MiB — signaling frames (SDP/ICE) are tiny
const MAX_TOPIC_LEN = 256
const MAX_CONNS_PER_IP = 50
const MAX_TOPICS_PER_CONN = 100
const RATE_LIMIT_MSGS = 200
const RATE_LIMIT_WINDOW_MS = 10_000
const PING_INTERVAL = 30000
const STATS = process.env.SIGNAL_STATS === '1'

const WS_OPEN = 1

/** topic -> Set<WebSocket> */
const topics = new Map()

let statConns = 0
let statPublishes = 0
let statRateDrops = 0
let statTopicDrops = 0
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
        for (const t of msg.topics || []) {
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
        for (const t of msg.topics || []) {
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
        if (process.env.SIGNAL_DEBUG) console.log('[signal] publish', msg.topic, 'datatype=', typeof msg.data, 'val=', JSON.stringify(msg.data).slice(0, 200));
        if (!validTopic(msg.topic)) {
          break
        }
        const receivers = topics.get(msg.topic)
        if (receivers !== undefined && receivers.size > 0) {
          statPublishes++
          // Payload is forwarded opaquely — never inspected or logged.
          // Sender echo is suppressed (clients ignore their own peerId anyway).
          const out = { type: 'publish', topic: msg.topic, data: msg.data, clients: receivers.size }
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

const requestHandler = (req, res) => {
  if (req.url === '/health') {
    const body = JSON.stringify({ ok: true, topics: topics.size })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(body)
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('okay')
}
const useTls = fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY)
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
    console.log(`stats: topics=${topics.size} connections=${statConns} publishes=${statPublishes} rateDrops=${statRateDrops} topicDrops=${statTopicDrops}`)
  }, 5000).unref()
}
