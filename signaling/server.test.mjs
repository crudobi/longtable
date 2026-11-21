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
import { spawn } from 'node:child_process'
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
      // Nonexistent cert paths force the plain-ws fallback (no TLS in tests).
      TLS_CERT: '/nonexistent/longtable-test.crt',
      TLS_KEY: '/nonexistent/longtable-test.key',
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
