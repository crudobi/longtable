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
