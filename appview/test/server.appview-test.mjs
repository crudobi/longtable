import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAppView } from '../server.mjs'
import { makeDevice } from './signed-fixtures.mjs'

// The AppView is a public read API consumed cross-origin by the Longtable
// app (Capacitor origin https://localhost). Without CORS headers the
// WebView refuses to expose responses to the app — in-app discovery broke
// exactly this way once (caught by e2e/proof-public.mjs). These tests pin
// the headers so it cannot regress silently.

let app
let base

beforeAll(async () => {
  app = createAppView({
    dbPath: ':memory:',
    pdsUrl: 'http://localhost:2583',
    plcUrl: 'http://localhost:2582',
    repoStateProvider: async () => {
      throw new Error('no network in server tests')
    },
    log: { log() {}, info() {}, warn() {}, error() {} },
  })
  const addr = await app.listen(0)
  base = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await app.close()
})

describe('appview HTTP API', () => {
  it('GET /health responds ok WITH CORS headers', async () => {
    const res = await fetch(`${base}/health`, { headers: { Origin: 'https://localhost' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it('OPTIONS preflight is answered with CORS headers', async () => {
    const res = await fetch(`${base}/search`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://localhost',
        'Access-Control-Request-Method': 'GET',
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-methods')).toContain('GET')
  })

  it('GET /search returns the results envelope (empty index)', async () => {
    const res = await fetch(`${base}/search?q=anything`)
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    const body = await res.json()
    expect(Array.isArray(body.results)).toBe(true)
    expect(body.results.length).toBe(0)
  })

  it('GET /recipe/ and /search carry deviceDid/deviceSignature/deviceKey', async () => {
    const device = makeDevice()
    app.index.upsert({
      uri: 'at://did:plc:testauthor/kitchen.longtable.recipe/signed',
      did: 'did:plc:testauthor',
      rkey: 'signed',
      cid: 'cid-signed-v1',
      record: {
        $type: 'kitchen.longtable.recipe',
        name: 'Signed Soup',
        ingredients: ['1 egg'],
        instructions: ['Cook it.'],
        longtableId: 'lt-signed',
        createdAt: '2026-10-12T00:00:00.000Z',
        deviceDid: device.deviceDid,
        deviceSignature: 'c2lnbmF0dXJl',
      },
      deviceKey: device.devicePublicKey,
    })
    const full = await (await fetch(`${base}/recipe/did:plc:testauthor/signed`)).json()
    expect(full.deviceDid).toBe(device.deviceDid)
    expect(full.deviceSignature).toBe('c2lnbmF0dXJl')
    expect(full.deviceKey).toBe(device.devicePublicKey)
    const search = await (await fetch(`${base}/search?q=Signed`)).json()
    expect(search.results).toHaveLength(1)
    expect(search.results[0].deviceDid).toBe(device.deviceDid)
    expect(search.results[0].deviceSignature).toBe('c2lnbmF0dXJl')
    expect(search.results[0].deviceKey).toBe(device.devicePublicKey)
    const author = await (await fetch(`${base}/author/did:plc:testauthor`)).json()
    expect(author.results).toHaveLength(1)
    expect(author.results[0].deviceKey).toBe(device.devicePublicKey)
  })

  it('GET /recipe/:did/:rkey 404s for unknown records, still with CORS', async () => {
    const res = await fetch(`${base}/recipe/did:plc:doesnotexist/nope`)
    expect(res.status).toBe(404)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })
})

describe('appview HTTP API: NULL-signature (pre-C2) rows are never served (S2)', () => {
  it('GET /search, /recipe/ and /author/ exclude rows with NULL signature fields', async () => {
    // A row indexed before C2: no device fields at all. It stays in the
    // store (so the reconcile sweep can find its DID and re-verify it)
    // but must never be served until then.
    app.index.upsert({
      uri: 'at://did:plc:testauthor/kitchen.longtable.recipe/legacy',
      did: 'did:plc:testauthor',
      rkey: 'legacy',
      cid: 'cid-legacy-v1',
      record: {
        $type: 'kitchen.longtable.recipe',
        name: 'Legacy Soup',
        ingredients: ['1 egg'],
        instructions: ['Cook it.'],
        longtableId: 'lt-legacy',
        createdAt: '2026-10-12T00:00:00.000Z',
      },
    })
    const search = await (await fetch(`${base}/search?q=Legacy`)).json()
    expect(search.results.filter((r) => r.rkey === 'legacy')).toHaveLength(0)
    const full = await fetch(`${base}/recipe/did:plc:testauthor/legacy`)
    expect(full.status).toBe(404)
    const author = await (await fetch(`${base}/author/did:plc:testauthor`)).json()
    expect(author.results.filter((r) => r.rkey === 'legacy')).toHaveLength(0)
    // ...while the verified row from the earlier test is still served,
    // and /stats reports the unverified remainder.
    const signed = await (await fetch(`${base}/search?q=Signed`)).json()
    expect(signed.results).toHaveLength(1)
    const stats = await (await fetch(`${base}/stats`)).json()
    expect(stats.unverified).toBeGreaterThanOrEqual(1)
  })
})
