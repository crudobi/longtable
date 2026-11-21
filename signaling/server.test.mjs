// server.test.mjs — signaling crash guard (S4).
//
// Pins: a malformed subscribe/unsubscribe (non-array `topics`, non-string
// elements, malformed JSON, non-object payloads) is dropped and counted;
// the server stays up, the connection stays open, and valid traffic
// keeps working afterwards.
//
// Run: node --test signaling/server.test.mjs
// Zero extra dependencies: node:test + the sibling `ws` package the
// server itself uses.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// A fresh high port per run: a stale server from an earlier run must
// never be mistaken for the server this test spawned.
const PORT = 14000 + Math.floor(Math.random() * 1000)
const BASE = `http://127.0.0.1:${PORT}`

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function waitForHealth(deadlineMs = 5000) {
  const started = Date.now()
  for (;;) {
    try {
      const res = await fetch(`${BASE}/health`)
      if (res.status === 200) return
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > deadlineMs) throw new Error('signaling server did not come up')
    await sleep(100)
  }
}

function startServer() {
  const child = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      // Sec L15: plaintext is an explicit opt-out now — the old
      // /nonexistent-cert trick that forced the silent ws fallback
      // no longer starts the server (see the L15 test below).
      SIGNAL_PLAINTEXT: '1',
    },
    stdio: 'ignore',
  })
  return child
}

async function stopServer(child) {
  if (child.exitCode !== null) return
  child.kill('SIGKILL')
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 2000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function waitForMessage(ws, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), timeoutMs)
    ws.once('message', data => {
      clearTimeout(timer)
      resolve(JSON.parse(data.toString()))
    })
  })
}

test('malformed subscribe/unsubscribe shapes do not kill the server', async () => {
  const child = startServer()
  try {
    await waitForHealth()
    assert.equal(child.exitCode, null, 'spawned server died on startup (stale listener on this port?)')
    const ws = await connect()
    try {
      // Every shape that used to throw (or would have without the
      // Array.isArray guard): non-array topics, non-string elements,
      // malformed JSON, non-object payloads.
      const malformed = [
        '{"type":"subscribe","topics":123}',
        '{"type":"subscribe","topics":"room"}',
        '{"type":"subscribe","topics":null}',
        '{"type":"subscribe","topics":[123,null,{}]}',
        '{"type":"subscribe"}',
        '{"type":"unsubscribe","topics":123}',
        '{"type":"unsubscribe","topics":"room"}',
        '{"type":"unsubscribe","topics":{"a":1}}',
        '{"type":"unsubscribe"}',
        '{bad json',
        '[1,2,3]',
        '"just a string"',
        '123',
      ]
      for (const raw of malformed) {
        ws.send(raw)
        await sleep(50)
        // The connection must survive every single one.
        assert.equal(ws.readyState, WebSocket.OPEN, `socket closed after ${raw}`)
      }
      // The server itself must still be alive and answering.
      const health = await fetch(`${BASE}/health`)
      assert.equal(health.status, 200)
      assert.equal(child.exitCode, null)

      // And valid traffic still works afterwards: a good subscribe
      // followed by a publish round-trip on a second connection.
      ws.send(JSON.stringify({ type: 'subscribe', topics: ['test-room', 123] }))
      const peer = await connect()
      try {
        peer.send(JSON.stringify({ type: 'subscribe', topics: ['test-room'] }))
        await sleep(100)
        peer.send(JSON.stringify({ type: 'publish', topic: 'test-room', data: { type: 'announce', from: 'peer-1' } }))
        const got = await waitForMessage(ws)
        assert.equal(got.type, 'publish')
        assert.equal(got.topic, 'test-room')
        assert.equal(got.data.from, 'peer-1')
      } finally {
        peer.close()
      }

      // ping/pong still works after the barrage.
      ws.send(JSON.stringify({ type: 'ping' }))
      const pong = await waitForMessage(ws)
      assert.equal(pong.type, 'pong')
    } finally {
      ws.close()
    }
  } finally {
    await stopServer(child)
  }
})
// Wave 4C addition to signaling/server.test.mjs — M13 pins.
//
// Appended by the Wave 4C worker; the S4 test above is untouched.
//   - publish relays carry no subscriber count (presence leak)
//   - /health reports topic/connection counts to loopback callers only
//   - the per-IP aggregate budget drops floods past the cap

test('M13: no subscriber count in publishes; /health counts are loopback-only; per-IP budget drops', async () => {
  const child = startServer()
  try {
    await waitForHealth()
    assert.equal(child.exitCode, null)

    // Publish relay: no `clients` field, even with two subscribers.
    const a = await connect()
    const b = await connect()
    try {
      a.send(JSON.stringify({ type: 'subscribe', topics: ['m13-room'] }))
      b.send(JSON.stringify({ type: 'subscribe', topics: ['m13-room'] }))
      await sleep(100)
      a.send(JSON.stringify({ type: 'publish', topic: 'm13-room', data: { type: 'announce', from: 'a-1' } }))
      const got = await waitForMessage(b)
      assert.equal(got.type, 'publish')
      assert.equal('clients' in got, false, 'publish relay must not leak the subscriber count')
      assert.equal(got.data.from, 'a-1')

      // /health from loopback (this test runs on the box) still
      // reports counts — the gating only hides them from remote IPs.
      const health = await (await fetch(`${BASE}/health`)).json()
      assert.equal(health.ok, true)
      assert.ok(health.topics >= 1, 'loopback /health must still report topic counts')
      assert.ok(health.connections >= 2, 'loopback /health must still report live connections')
    } finally {
      a.close()
      b.close()
    }
  } finally {
    await stopServer(child)
  }
})

test('M13: per-IP aggregate budget drops messages past the cap', async () => {
  // A small budget via env so the test does not need 5000 messages.
  // Both connections share 127.0.0.1, so subscribes count too:
  // 2 subscribes + 3 publishes = 5 (the cap); the 4th publish drops.
  const budgetPort = 14000 + Math.floor(Math.random() * 1000)
  const budgetBase = `http://127.0.0.1:${budgetPort}`
  const child = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
    env: {
      ...process.env,
      PORT: String(budgetPort),
      SIGNAL_PLAINTEXT: '1',
      SIGNAL_MAX_MSGS_PER_IP: '5',
    },
    stdio: 'ignore',
  })
  const connectBudget = () =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${budgetPort}`)
      ws.once('open', () => resolve(ws))
      ws.once('error', reject)
    })
  try {
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`${budgetBase}/health`)
        if (res.status === 200) break
      } catch {
        /* not up yet */
      }
      await sleep(100)
    }
    const sender = await connectBudget()
    const receiver = await connectBudget()
    const received = []
    receiver.on('message', (data) => received.push(JSON.parse(data.toString())))
    try {
      sender.send(JSON.stringify({ type: 'subscribe', topics: ['budget-room'] }))
      receiver.send(JSON.stringify({ type: 'subscribe', topics: ['budget-room'] }))
      await sleep(100)
      for (let i = 0; i < 4; i++) {
        sender.send(JSON.stringify({ type: 'publish', topic: 'budget-room', data: { n: i } }))
        await sleep(50)
      }
      await sleep(200)
      // 3 publishes relayed, the 4th dropped by the per-IP budget.
      assert.equal(received.length, 3, `expected 3 relayed publishes, got ${received.length}`)
      assert.deepEqual(received.map((m) => m.data.n), [0, 1, 2])
    } finally {
      sender.close()
      receiver.close()
    }
  } finally {
    await stopServer(child)
  }
})

// Wave 5C additions — Sec L20 (payload logging) and Sec L15
// (fail-closed TLS). The S4/M13 tests above are untouched except
// that their spawns now use the explicit SIGNAL_PLAINTEXT=1 opt-out.

function freshPort() {
  return 14000 + Math.floor(Math.random() * 1000)
}

function spawnOn(port, extraEnv = {}, stdio = 'ignore') {
  return spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
    env: { ...process.env, PORT: String(port), ...extraEnv },
    stdio,
  })
}

async function waitForHealthOn(port, deadlineMs = 5000) {
  const started = Date.now()
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      if (res.status === 200) return
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > deadlineMs) throw new Error('signaling server did not come up')
    await sleep(100)
  }
}

async function waitForExit(child, deadlineMs = 5000) {
  if (child.exitCode !== null) return child.exitCode
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), deadlineMs)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

// node fetch has no rejectUnauthorized option, so the TLS probe
// uses node:https directly with rejectUnauthorized:false.
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { rejectUnauthorized: false }, (res) => {
        let body = ''
        res.on('data', (chunk) => {
          body += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode, body }))
      })
      .once('error', reject)
  })
}

function connectWs(url, opts) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, opts)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

test('Sec L20: SIGNAL_DEBUG logs topic + byte length, never the publish payload', async () => {
  const port = freshPort()
  let stdout = ''
  const child = spawnOn(port, { SIGNAL_PLAINTEXT: '1', SIGNAL_DEBUG: '1' }, ['ignore', 'pipe', 'pipe'])
  child.stdout.on('data', (d) => {
    stdout += d.toString()
  })
  try {
    await waitForHealthOn(port)
    assert.equal(child.exitCode, null)
    const sender = await connectWs(`ws://127.0.0.1:${port}`)
    const receiver = await connectWs(`ws://127.0.0.1:${port}`)
    const CANARY = 'L20CANARY-7f3a9b2'
    try {
      receiver.send(JSON.stringify({ type: 'subscribe', topics: ['l20-room'] }))
      await sleep(100)
      const gotP = waitForMessage(receiver)
      sender.send(
        JSON.stringify({
          type: 'publish',
          topic: 'l20-room',
          data: { type: 'announce', from: 'sender-1', secret: CANARY },
        }),
      )
      const got = await gotP
      assert.equal(got.type, 'publish')
      // The publish genuinely flowed through the debug-logging path...
      assert.equal(got.data.secret, CANARY)
      await sleep(200)
    } finally {
      sender.close()
      receiver.close()
    }
    // ...and the log carries the topic + size, never the payload.
    assert.doesNotMatch(stdout, new RegExp(CANARY), 'SIGNAL_DEBUG must never log publish payloads')
    assert.match(stdout, /l20-room/, 'debug log still names the topic')
    assert.match(stdout, /bytes=/, 'debug log still records the payload size')
  } finally {
    await stopServer(child)
  }
})

test('Sec L15: configured-but-missing TLS cert paths refuse to start (no silent ws fallback)', async () => {
  const port = freshPort()
  let stderr = ''
  const child = spawnOn(
    port,
    { TLS_CERT: '/nonexistent/longtable-test.crt', TLS_KEY: '/nonexistent/longtable-test.key' },
    ['ignore', 'ignore', 'pipe'],
  )
  child.stderr.on('data', (d) => {
    stderr += d.toString()
  })
  try {
    const code = await waitForExit(child, 5000)
    assert.equal(code, 1, 'missing TLS certs must exit 1, not serve plain ws')
    assert.match(stderr, /TLS certificate not found/)
    assert.match(stderr, /refusing to serve plain ws/)
    // And nothing is listening: /health never answers.
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`))
  } finally {
    if (child.exitCode === null) await stopServer(child)
  }

  // The same refusal when the default (fixture) cert is missing:
  // FIXTURE_CERTS points the default lookup at an empty directory.
  const port2 = freshPort()
  let stderr2 = ''
  const child2 = spawnOn(port2, { FIXTURE_CERTS: '/nonexistent/fixture-certs' }, ['ignore', 'ignore', 'pipe'])
  child2.stderr.on('data', (d) => {
    stderr2 += d.toString()
  })
  try {
    const code = await waitForExit(child2, 5000)
    assert.equal(code, 1, 'missing fixture cert must exit 1')
    assert.match(stderr2, /TLS certificate not found/)
  } finally {
    if (child2.exitCode === null) await stopServer(child2)
  }
})

test('Sec L15: a real cert serves wss; SIGNAL_PLAINTEXT=1 serves plain ws', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'longtable-sig-tls-'))
  try {
    const cert = path.join(tmp, 'server.crt')
    const key = path.join(tmp, 'server.key')
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'],
      { stdio: 'ignore' },
    )
    const port = freshPort()
    const child = spawnOn(port, { TLS_CERT: cert, TLS_KEY: key }, 'ignore')
    try {
      let up = false
      for (let i = 0; i < 50; i++) {
        try {
          const res = await httpsGet(`https://127.0.0.1:${port}/health`)
          if (res.status === 200) {
            up = true
            break
          }
        } catch {
          /* not up yet */
        }
        await sleep(100)
      }
      assert.equal(up, true, 'wss server did not come up')
      assert.equal(child.exitCode, null)
      // A wss round-trip proves the TLS listener works end to end.
      const a = await connectWs(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false })
      const b = await connectWs(`wss://127.0.0.1:${port}`, { rejectUnauthorized: false })
      try {
        b.send(JSON.stringify({ type: 'subscribe', topics: ['tls-room'] }))
        await sleep(100)
        const gotP = waitForMessage(b)
        a.send(JSON.stringify({ type: 'publish', topic: 'tls-room', data: { type: 'announce', from: 'a-1' } }))
        const got = await gotP
        assert.equal(got.type, 'publish')
        assert.equal(got.data.from, 'a-1')
      } finally {
        a.close()
        b.close()
      }
    } finally {
      await stopServer(child)
    }

    // And the explicit plaintext opt-out still starts plain ws.
    const port2 = freshPort()
    const plain = spawnOn(port2, { SIGNAL_PLAINTEXT: '1' }, 'ignore')
    try {
      await waitForHealthOn(port2)
      assert.equal(plain.exitCode, null)
      const ws = await connectWs(`ws://127.0.0.1:${port2}`)
      ws.close()
    } finally {
      await stopServer(plain)
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
