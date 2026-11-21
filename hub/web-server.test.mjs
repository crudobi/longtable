// web-server.test.mjs — static-host containment (S5).
//
// Pins: a request that resolves outside WEB_ROOT — in particular a
// sibling directory whose name shares WEB_ROOT's prefix (e.g. ROOT
// /x/app vs /x/appview, which the old startsWith(ROOT) check let
// through) — is rejected with 403 and never serves the sibling file.
// Legitimate paths and the SPA fallback keep working.
//
// Run: node --test hub/web-server.test.mjs
// Zero extra dependencies: node:test only; the fixture tree is built
// in a temp dir per run.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// A fresh high port per run: a stale server from an earlier run must
// never be mistaken for the server this test spawned.
const PORT = 18100 + Math.floor(Math.random() * 500)
const BASE = `http://127.0.0.1:${PORT}`

const sleep = ms => new Promise(r => setTimeout(r, ms))

// Raw request: fetch()/URL normalize `..` segments client-side before
// anything hits the wire, which would test the client, not the server.
// node:http sends `path` verbatim, like curl does.
function rawGet(rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: rawPath }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.once('error', reject)
  })
}

async function waitForUp(deadlineMs = 5000) {
  const started = Date.now()
  for (;;) {
    try {
      const res = await fetch(`${BASE}/`)
      if (res.status === 200) return
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > deadlineMs) throw new Error('web server did not come up')
    await sleep(100)
  }
}

test('traversal to a same-prefix sibling is rejected; legit paths still serve', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'longtable-web-test-'))
  const root = path.join(tmp, 'app')
  // Sibling whose name shares ROOT's prefix: the exact S5 bypass shape.
  const sibling = path.join(tmp, 'appview')
  const sibling2 = path.join(tmp, 'app2')
  fs.mkdirSync(root, { recursive: true })
  fs.mkdirSync(sibling, { recursive: true })
  fs.mkdirSync(sibling2, { recursive: true })
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>app shell</h1>\n')
  fs.writeFileSync(path.join(root, 'asset.js'), 'console.log("app");\n')
  fs.writeFileSync(path.join(sibling, 'server.mjs'), '// SIBLING-MARKER must never be served\n')
  fs.writeFileSync(path.join(sibling2, 'x.txt'), 'SIBLING2-MARKER\n')

  const child = spawn(process.execPath, [path.join(HERE, 'web-server.mjs')], {
    env: { ...process.env, WEB_PORT: String(PORT), WEB_ROOT: root },
    stdio: 'ignore',
  })
  try {
    await waitForUp()
    assert.equal(child.exitCode, null, 'spawned server died on startup (stale listener on this port?)')

    // Legitimate paths still serve.
    const home = await fetch(`${BASE}/`)
    assert.equal(home.status, 200)
    assert.match(await home.text(), /app shell/)
    const asset = await fetch(`${BASE}/asset.js`)
    assert.equal(asset.status, 200)

    // SPA fallback for unknown in-root paths still serves the shell.
    const missing = await fetch(`${BASE}/no-such-route`)
    assert.equal(missing.status, 200)
    assert.match(await missing.text(), /app shell/)

    // The S5 bypass shapes: must NOT return 200, must NOT leak the file.
    // Sent raw — fetch() would normalize the `..` away client-side.
    for (const p of [
      '/../appview/server.mjs',
      '/..%2fappview/server.mjs',
      '/%2e%2e/appview/server.mjs',
      '/../app2/x.txt',
      '/..%2fapp2%2fx.txt',
    ]) {
      const res = await rawGet(p)
      assert.notEqual(res.status, 200, `traversal ${p} returned 200`)
      assert.doesNotMatch(res.body, /SIBLING-MARKER|SIBLING2-MARKER/, `traversal ${p} leaked a sibling file`)
    }

    // A non-traversal odd path (....//) resolves inside ROOT and must
    // not leak either — it falls back to the app shell.
    const weird = await rawGet('/....//appview/server.mjs')
    assert.doesNotMatch(weird.body, /SIBLING-MARKER/)
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL')
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 2000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
// Wave 4C addition to hub/web-server.test.mjs — M15 pins.
//
// Appended by the Wave 4C worker; the S5 test above is untouched.
//   - every response carries the security headers
//   - WEB_TLS_CERT/WEB_TLS_KEY serve HTTPS with those headers
//   - error responses are generic (no leaked error strings)

import { execFileSync } from 'node:child_process'
import https from 'node:https'

function rawGetPort(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: rawPath }, res => {
      let body = ''
      res.on('data', chunk => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }))
    })
    req.once('error', reject)
  })
}

test('M15: security headers on 200s and on the 403; no error strings leak', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'longtable-web-m15-'))
  const root = path.join(tmp, 'app')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>app shell</h1>\n')
  const port = 18200 + Math.floor(Math.random() * 500)
  const child = spawn(process.execPath, [path.join(HERE, 'web-server.mjs')], {
    env: { ...process.env, WEB_PORT: String(port), WEB_ROOT: root },
    stdio: 'ignore',
  })
  try {
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`)
        if (res.status === 200) break
      } catch {
        /* not up yet */
      }
      await sleep(100)
    }
    assert.equal(child.exitCode, null)
    const checkHeaders = (headers) => {
      assert.equal(headers['x-content-type-options'], 'nosniff')
      assert.equal(headers['x-frame-options'], 'SAMEORIGIN')
      assert.equal(headers['referrer-policy'], 'no-referrer')
      assert.equal(headers['content-security-policy'], "frame-ancestors 'self'")
    }
    const home = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(home.status, 200)
    checkHeaders(Object.fromEntries(home.headers.entries()))
    // The 403 carries the same headers.
    const forbidden = await rawGetPort(port, '/../appview/server.mjs')
    assert.equal(forbidden.status, 403)
    checkHeaders(forbidden.headers)
    assert.doesNotMatch(forbidden.body, /appview|server\.mjs/)
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL')
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 2000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('M15: WEB_TLS_CERT/WEB_TLS_KEY serve HTTPS', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'longtable-web-tls-'))
  const root = path.join(tmp, 'app')
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'index.html'), '<h1>tls shell</h1>\n')
  const cert = path.join(tmp, 'server.crt')
  const key = path.join(tmp, 'server.key')
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=localhost',
  ], { stdio: 'ignore' })
  const port = 18300 + Math.floor(Math.random() * 500)
  const child = spawn(process.execPath, [path.join(HERE, 'web-server.mjs')], {
    env: {
      ...process.env,
      WEB_PORT: String(port),
      WEB_ROOT: root,
      WEB_TLS_CERT: cert,
      WEB_TLS_KEY: key,
    },
    stdio: 'ignore',
  })
  // node fetch has no rejectUnauthorized option, so the TLS probe
  // uses node:https directly with rejectUnauthorized:false.
  const httpsGet = (url) =>
    new Promise((resolve, reject) => {
      https
        .get(url, { rejectUnauthorized: false }, (res) => {
          let body = ''
          res.on('data', (chunk) => {
            body += chunk
          })
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
        })
        .once('error', reject)
    })
  try {
    let up = false
    for (let i = 0; i < 50; i++) {
      try {
        const res = await httpsGet(`https://127.0.0.1:${port}/`)
        if (res.status === 200) {
          up = true
          assert.match(res.body, /tls shell/)
          assert.equal(res.headers['x-content-type-options'], 'nosniff')
          break
        }
      } catch {
        /* not up yet */
      }
      await sleep(100)
    }
    assert.equal(up, true, 'TLS web server did not come up')
    assert.equal(child.exitCode, null)
    // Plain HTTP to the TLS port must NOT answer HTTP.
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`))
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL')
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 2000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
