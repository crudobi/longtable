import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAppView } from '../server.mjs'
import { isCacheableMediaId } from '../media.mjs'

// Phase 4: the hub AppView caches public media (recipe photos) from the
// PDS, content-addressed by (did, cid). First fetch goes to the PDS;
// repeats are served from disk without touching the PDS again.

const DID = 'did:plc:mediatest123'
const CID = 'bafkreimediatestcid0001'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

let app
let base
let mediaDir
let pdsFetches = 0

beforeAll(async () => {
  mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-media-test-'))
  const fetchImpl = async (url) => {
    const u = new URL(url)
    if (u.pathname === '/xrpc/com.atproto.sync.getBlob') {
      pdsFetches++
      if (u.searchParams.get('cid') === CID) {
        return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
      }
      return new Response('not found', { status: 404 })
    }
    throw new Error(`unexpected fetch in media test: ${url}`)
  }
  app = createAppView({
    dbPath: ':memory:',
    mediaDir,
    pdsUrl: 'http://pds.test',
    plcUrl: 'http://plc.test',
    repoStateProvider: async () => {
      throw new Error('no network in media tests')
    },
    fetchImpl,
    log: { log() {}, info() {}, warn() {}, error() {} },
  })
  const addr = await app.listen(0)
  base = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await app.close()
  fs.rmSync(mediaDir, { recursive: true, force: true })
})

describe('appview media cache', () => {
  it('first request fetches from the PDS (miss), second is a cache hit', async () => {
    const r1 = await fetch(`${base}/media/${encodeURIComponent(DID)}/${CID}`)
    expect(r1.status).toBe(200)
    expect(r1.headers.get('x-longtable-media-cache')).toBe('miss')
    expect(r1.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await r1.arrayBuffer()).equals(PNG)).toBe(true)
    expect(pdsFetches).toBe(1)

    const r2 = await fetch(`${base}/media/${encodeURIComponent(DID)}/${CID}`)
    expect(r2.status).toBe(200)
    expect(r2.headers.get('x-longtable-media-cache')).toBe('hit')
    expect(Buffer.from(await r2.arrayBuffer()).equals(PNG)).toBe(true)
    expect(pdsFetches).toBe(1) // still one: the PDS was NOT asked again
  })

  it('unknown blob 404s', async () => {
    const res = await fetch(`${base}/media/${encodeURIComponent(DID)}/bafkreiunknown000`)
    expect(res.status).toBe(404)
  })

  it('path traversal / malformed ids are rejected', async () => {
    expect(isCacheableMediaId('did:plc:abc', 'bafkrei123')).toBe(true)
    expect(isCacheableMediaId('../etc', 'bafkrei123')).toBe(false)
    expect(isCacheableMediaId('did:plc:abc', '../passwd')).toBe(false)
    expect(isCacheableMediaId('did:plc:abc', 'a/b')).toBe(false)
    const res = await fetch(`${base}/media/not-a-did/bafkrei123`)
    expect(res.status).toBe(404)
  })

  it('/stats reports media cache counters', async () => {
    const res = await fetch(`${base}/stats`)
    const body = await res.json()
    expect(body.media).toBeTruthy()
    expect(body.media.hits).toBeGreaterThanOrEqual(1)
    expect(body.media.fetches).toBeGreaterThanOrEqual(1)
  })
})
