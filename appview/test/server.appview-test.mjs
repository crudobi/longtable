import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAppView } from '../server.mjs'

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

  it('GET /recipe/:did/:rkey 404s for unknown records, still with CORS', async () => {
    const res = await fetch(`${base}/recipe/did:plc:doesnotexist/nope`)
    expect(res.status).toBe(404)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })
})
