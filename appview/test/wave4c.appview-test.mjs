// wave4c.appview-test.mjs — Wave 4C server-side fixes.
//
// H1 media purge on unpublish/delete (+ orphan backstop), H2
// Content-Type allowlist on served blobs, H3 persisted firehose
// cursor, M12 AppView rate limits + media gating + /author/ bound,
// M4(int) /search query bounds, M5 unicode FTS terms + LIKE escaping,
// M6 upsert/FTS atomicity (observable invariant: row and FTS agree).
//
// Run: npm test (vitest) in appview/.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { createAppView } from '../server.mjs'
import { RecipeIndex, ftsTerms, escapeLikePattern } from '../db.mjs'
import {
  createMediaCache,
  rawCidForBytes,
  safeMediaContentType,
} from '../media.mjs'
import {
  createIngestor,
  loadFirehoseCursor,
  saveFirehoseCursor,
} from '../ingest.mjs'
import {
  makeDevice,
  perDeviceBindingEntry,
  signedRecipeRecord,
} from './signed-fixtures.mjs'

const quietLog = { log() {}, info() {}, warn() {}, error() {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- H1 ----
describe('H1: media purge on unpublish/delete', () => {
  const DID = 'did:plc:purgetest'
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9])
  const CID = rawCidForBytes(PNG)
  const ORPHAN = Buffer.from('orphan bytes, no recipe points at these')
  const ORPHAN_CID = rawCidForBytes(ORPHAN)

  it('delete()/purgeImages()/purgeUnreferenced() remove bytes + meta', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-wave4c-purge-'))
    try {
      const cache = createMediaCache({
        dir,
        pdsUrl: 'http://pds.test',
        fetchImpl: async (u) => {
          const cid = new URL(u).searchParams.get('cid')
          if (cid === CID) return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
          if (cid === ORPHAN_CID) return new Response(ORPHAN, { status: 200, headers: { 'content-type': 'image/png' } })
          return new Response('nf', { status: 404 })
        },
        log: quietLog,
      })
      const sub = path.join(dir, encodeURIComponent(DID))
      await cache.get(DID, CID)
      await cache.get(DID, ORPHAN_CID)
      expect(fs.existsSync(path.join(sub, CID))).toBe(true)
      expect(fs.existsSync(path.join(sub, ORPHAN_CID))).toBe(true)

      // delete(): single blob, idempotent.
      expect(cache.delete(DID, CID)).toBe(true)
      expect(fs.existsSync(path.join(sub, CID))).toBe(false)
      expect(fs.existsSync(path.join(sub, `${CID}.json`))).toBe(false)
      expect(cache.delete(DID, CID)).toBe(false)

      // purgeImages(): by recipe images array (ref.$link shape).
      await cache.get(DID, CID)
      expect(cache.purgeImages(DID, [{ ref: { $link: CID } }])).toBe(1)
      expect(fs.existsSync(path.join(sub, CID))).toBe(false)

      // purgeUnreferenced(): an orphan (no indexed recipe) goes; a
      // referenced blob stays.
      const index = new RecipeIndex(':memory:')
      try {
        index.upsert({
          uri: `at://${DID}/kitchen.longtable.recipe/soup`,
          did: DID,
          rkey: 'soup',
          cid: 'cid-soup',
          record: {
            name: 'Soup',
            ingredients: [],
            instructions: [],
            images: [{ ref: { $link: CID } }],
          },
        })
        await cache.get(DID, CID)
        await cache.get(DID, ORPHAN_CID)
        expect(cache.purgeUnreferenced(index)).toBe(1)
        expect(fs.existsSync(path.join(sub, CID))).toBe(true)
        expect(fs.existsSync(path.join(sub, ORPHAN_CID))).toBe(false)
      } finally {
        index.close()
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reconcile sweep purges media for the deleted recipe', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-wave4c-sweep-'))
    const index = new RecipeIndex(':memory:')
    const device = makeDevice()
    const state = { records: [] }
    try {
      const cache = createMediaCache({
        dir,
        pdsUrl: 'http://pds.test',
        fetchImpl: async () =>
          new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }),
        log: quietLog,
      })
      const ingestor = createIngestor({
        index,
        repoStateProvider: async () => ({ did: DID, commitCid: 'bafyfake', records: state.records }),
        pdsUrl: 'http://localhost:2583',
        log: quietLog,
        media: cache,
      })
      const binding = perDeviceBindingEntry(device, DID)
      const recipe = {
        collection: 'kitchen.longtable.recipe',
        rkey: 'lt-purge-soup',
        cid: 'cid-soup',
        record: signedRecipeRecord(device, DID, 'Purge Soup', ['1 egg'], {
          images: [{ ref: { $link: CID } }],
        }),
      }
      state.records = [binding, recipe]
      const res = await ingestor.reconcileRepo(DID)
      expect(res.ok).toBe(true)
      expect(index.count()).toBe(1)

      // Prime the cache the way a viewer would (via the cache, whose
      // gating lives in the HTTP layer, not here).
      const got = await cache.get(DID, CID)
      expect(got).not.toBeNull()
      const sub = path.join(dir, encodeURIComponent(DID))
      expect(fs.existsSync(path.join(sub, CID))).toBe(true)

      // The author unpublishes: the recipe vanishes from the repo.
      state.records = [binding]
      const res2 = await ingestor.reconcileRepo(DID)
      expect(res2.deleted).toBe(1)
      expect(index.count()).toBe(0)
      expect(fs.existsSync(path.join(sub, CID))).toBe(false)
      expect(fs.existsSync(path.join(sub, `${CID}.json`))).toBe(false)
      expect(cache.stats.purged).toBeGreaterThanOrEqual(1)
      ingestor.close()
    } finally {
      index.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------- H2 ----
describe('H2: Content-Type allowlist', () => {
  it('safeMediaContentType passes images through, everything else to octet-stream', () => {
    expect(safeMediaContentType('image/png')).toBe('image/png')
    expect(safeMediaContentType('IMAGE/PNG')).toBe('image/png')
    expect(safeMediaContentType('image/png; charset=utf-8')).toBe('image/png')
    expect(safeMediaContentType('image/svg+xml')).toBe('application/octet-stream')
    expect(safeMediaContentType('text/html')).toBe('application/octet-stream')
    expect(safeMediaContentType('text/html; charset=utf-8')).toBe('application/octet-stream')
    expect(safeMediaContentType('application/javascript')).toBe('application/octet-stream')
    expect(safeMediaContentType(null)).toBe('application/octet-stream')
    expect(safeMediaContentType('')).toBe('application/octet-stream')
  })
})

// ------------------------------------------------- H2 + M12 + M4 (HTTP) ---
describe('appview HTTP: H2 serve-time types, M12 gating + rate limits, M4 bounds', () => {
  const DID = 'did:plc:httpmediatest'
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 6, 7])
  const PNG_CID = rawCidForBytes(PNG)
  const HTML = Buffer.from('<script>alert(1)</script>', 'utf8')
  const HTML_CID = rawCidForBytes(HTML)
  const ORPHAN = Buffer.from('would-be oracle bytes')
  const ORPHAN_CID = rawCidForBytes(ORPHAN)

  let app
  let base
  let mediaDir
  let pdsFetches

  beforeAll(async () => {
    mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-wave4c-http-'))
    pdsFetches = new Map()
    const fetchImpl = async (url) => {
      const u = new URL(url)
      const cid = u.searchParams.get('cid')
      pdsFetches.set(cid, (pdsFetches.get(cid) ?? 0) + 1)
      if (cid === PNG_CID) return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
      if (cid === HTML_CID) return new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } })
      if (cid === ORPHAN_CID) return new Response(ORPHAN, { status: 200, headers: { 'content-type': 'image/png' } })
      return new Response('not found', { status: 404 })
    }
    app = createAppView({
      dbPath: ':memory:',
      mediaDir,
      pdsUrl: 'http://pds.test',
      plcUrl: 'http://plc.test',
      repoStateProvider: async () => {
        throw new Error('no network in wave4c http tests')
      },
      fetchImpl,
      log: quietLog,
    })
    // The two blobs real recipes reference (device fields make them
    // served/verified rows, as in the server tests).
    const device = makeDevice()
    for (const [rkey, cid] of [
      ['pic', PNG_CID],
      ['evil', HTML_CID],
    ]) {
      app.index.upsert({
        uri: `at://${DID}/kitchen.longtable.recipe/${rkey}`,
        did: DID,
        rkey,
        cid: `cid-${rkey}`,
        record: {
          $type: 'kitchen.longtable.recipe',
          name: rkey === 'pic' ? 'Pic Soup' : 'Evil Soup',
          ingredients: ['1 egg'],
          instructions: ['Cook it.'],
          longtableId: `lt-${rkey}`,
          createdAt: '2026-10-12T00:00:00.000Z',
          deviceDid: device.deviceDid,
          deviceSignature: 'c2lnbmF0dXJl',
          images: [{ ref: { $link: cid } }],
        },
        deviceKey: device.devicePublicKey,
      })
    }
    const addr = await app.listen(0)
    base = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(mediaDir, { recursive: true, force: true })
  })

  it('H2: a PDS-claimed text/html blob is served as octet-stream + attachment + nosniff + CSP', async () => {
    const res = await fetch(`${base}/media/${encodeURIComponent(DID)}/${HTML_CID}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
    expect(res.headers.get('content-disposition')).toBe('attachment')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(Buffer.from(await res.arrayBuffer()).equals(HTML)).toBe(true)
  })

  it('H2: a real image keeps its type and gets nosniff + CSP, no attachment', async () => {
    const res = await fetch(`${base}/media/${encodeURIComponent(DID)}/${PNG_CID}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-disposition')).toBeNull()
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
  })

  it('M12: an unreferenced (did, cid) 404s and the PDS is never asked (no oracle)', async () => {
    const before = pdsFetches.get(ORPHAN_CID) ?? 0
    const res = await fetch(`${base}/media/${encodeURIComponent(DID)}/${ORPHAN_CID}`)
    expect(res.status).toBe(404)
    expect(pdsFetches.get(ORPHAN_CID) ?? 0).toBe(before)
  })

  it('M4(int): over-long q and too many ingredients are 400s', async () => {
    const longQ = await fetch(`${base}/search?q=${'a'.repeat(501)}`)
    expect(longQ.status).toBe(400)
    const manyIng = await fetch(
      `${base}/search?ingredients=${Array.from({ length: 21 }, (_, i) => `ing${i}`).join(',')}`,
    )
    expect(manyIng.status).toBe(400)
    // At the bounds, requests still work.
    const okQ = await fetch(`${base}/search?q=${'a'.repeat(500)}`)
    expect(okQ.status).toBe(200)
    const okIng = await fetch(
      `${base}/search?ingredients=${Array.from({ length: 20 }, (_, i) => `ing${i}`).join(',')}`,
    )
    expect(okIng.status).toBe(200)
  })

  it('M12: /author/ is bounded at 100 rows', async () => {
    const device = makeDevice()
    const did = 'did:plc:manyrecipes'
    for (let i = 0; i < 101; i++) {
      app.index.upsert({
        uri: `at://${did}/kitchen.longtable.recipe/r${i}`,
        did,
        rkey: `r${i}`,
        cid: `cid-r${i}`,
        record: {
          $type: 'kitchen.longtable.recipe',
          name: `Dish ${i}`,
          ingredients: [],
          instructions: [],
          longtableId: `lt-r${i}`,
          createdAt: '2026-10-12T00:00:00.000Z',
          deviceDid: device.deviceDid,
          deviceSignature: 'c2lnbmF0dXJl',
        },
        deviceKey: device.devicePublicKey,
      })
    }
    const res = await fetch(`${base}/author/${encodeURIComponent(did)}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toHaveLength(100)
  })

  it('M12: per-IP rate limit returns 429 with Retry-After past the cap', async () => {
    const limited = createAppView({
      dbPath: ':memory:',
      pdsUrl: 'http://pds.test',
      plcUrl: 'http://plc.test',
      repoStateProvider: async () => {
        throw new Error('no network')
      },
      log: quietLog,
      rateLimit: { windowMs: 60_000, maxRequests: 5 },
    })
    const addr = await limited.listen(0)
    const limitedBase = `http://127.0.0.1:${addr.port}`
    try {
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${limitedBase}/health`)
        expect(res.status).toBe(200)
      }
      const over = await fetch(`${limitedBase}/health`)
      expect(over.status).toBe(429)
      expect(over.headers.get('retry-after')).toBeTruthy()
      const body = await over.json()
      expect(body.error).toBe('rate limited')
    } finally {
      await limited.close()
    }
  })
})

// ---------------------------------------------------------------- M5 ----
describe('M5: unicode FTS terms + LIKE escaping', () => {
  it('ftsTerms keeps non-ASCII terms instead of dropping them', () => {
    expect(ftsTerms('Café naïve')).toEqual(['café', 'naïve'])
    expect(ftsTerms('crème brûlée 100%')).toEqual(['crème', 'brûlée', '100'])
  })

  it('escapeLikePattern escapes %, _ and backslash', () => {
    expect(escapeLikePattern('100%')).toBe('100\\%')
    expect(escapeLikePattern('a_b')).toBe('a\\_b')
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b')
    expect(escapeLikePattern('plain')).toBe('plain')
  })

  it('a unicode name is findable via FTS search', () => {
    const index = new RecipeIndex(':memory:')
    try {
      const device = makeDevice()
      index.upsert({
        uri: 'at://did:plc:unicode/kitchen.longtable.recipe/cafe',
        did: 'did:plc:unicode',
        rkey: 'cafe',
        cid: 'cid-cafe',
        record: {
          name: 'Café au lait',
          ingredients: ['coffee'],
          instructions: [],
          longtableId: 'lt-cafe',
          createdAt: '2026-10-12T00:00:00.000Z',
          deviceDid: device.deviceDid,
          deviceSignature: 'c2lnbmF0dXJl',
        },
        deviceKey: device.devicePublicKey,
      })
      expect(index.search({ q: 'café' })).toHaveLength(1)
      expect(index.search({ q: 'Café' })).toHaveLength(1)
    } finally {
      index.close()
    }
  })
})

// ---------------------------------------------------------------- M6 ----
describe('M6: row and FTS agree across upsert/replace/delete', () => {
  it('search tracks the row through replace and delete', () => {
    const index = new RecipeIndex(':memory:')
    try {
      const uri = 'at://did:plc:m6/kitchen.longtable.recipe/a'
      // A new CID per version: upsert skips the write entirely when
      // the CID and signature fields are unchanged, so the replace leg
      // must carry a new CID to exercise the row+FTS rewrite.
      const row = (name, cid) => ({
        uri,
        did: 'did:plc:m6',
        rkey: 'a',
        cid,
        record: { name, ingredients: ['egg'], instructions: [], longtableId: 'lt-a' },
      })
      index.upsert(row('Alpha Soup', 'cid-a1'))
      expect(index.search({ q: 'Alpha' })).toHaveLength(1)
      index.upsert(row('Alpha Salad', 'cid-a2'))
      expect(index.search({ q: 'Soup' })).toHaveLength(0)
      expect(index.search({ q: 'Salad' })).toHaveLength(1)
      expect(index.getRecipe('did:plc:m6', 'a').name).toBe('Alpha Salad')
      expect(index.deleteByUri(uri)).toBe(true)
      expect(index.search({ q: 'Salad' })).toHaveLength(0)
      expect(index.count()).toBe(0)
    } finally {
      index.close()
    }
  })
})

// ---------------------------------------------------------------- H3 ----
describe('H3: persisted firehose cursor', () => {
  it('load/save round-trip; corrupt or missing file means no cursor', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-wave4c-cursor-'))
    try {
      const file = path.join(dir, 'firehose-cursor.json')
      expect(loadFirehoseCursor(file)).toBeNull()
      saveFirehoseCursor(file, 12345)
      expect(loadFirehoseCursor(file)).toBe(12345)
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).seq).toBe(12345)
      fs.writeFileSync(file, 'not json{')
      expect(loadFirehoseCursor(file)).toBeNull()
      fs.writeFileSync(file, JSON.stringify({ seq: 'nope' }))
      expect(loadFirehoseCursor(file)).toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('handleFrame advances the cursor and it survives a restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-wave4c-cursor2-'))
    try {
      const file = path.join(dir, 'firehose-cursor.json')
      const index = new RecipeIndex(':memory:')
      try {
        const mk = () =>
          createIngestor({
            index,
            repoStateProvider: async () => ({ did: 'did:plc:x', records: [] }),
            pdsUrl: 'http://localhost:2583',
            log: quietLog,
            firehoseCursorPath: file,
          })
        const ingestor = mk()
        expect(ingestor.firehoseSeq).toBeNull()
        // A commit with no wanted ops still advances the cursor: the
        // cursor tracks firehose position, not just indexed commits.
        expect(
          ingestor.handleFrame(
            { op: 1, t: '#commit' },
            { seq: 42, repo: 'did:plc:x', ops: [{ path: 'app.bsky.feed.post/p' }] },
          ),
        ).toBe(false)
        expect(ingestor.firehoseSeq).toBe(42)
        ingestor.persistFirehoseCursor()
        expect(loadFirehoseCursor(file)).toBe(42)
        ingestor.close()
        // A fresh ingestor on the same file resumes from 42.
        const resumed = mk()
        expect(resumed.firehoseSeq).toBe(42)
        resumed.close()
      } finally {
        index.close()
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('startFirehose subscribes with ?cursor= when a cursor is persisted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-wave4c-cursor3-'))
    const file = path.join(dir, 'firehose-cursor.json')
    saveFirehoseCursor(file, 99)
    const wss = new WebSocketServer({ port: 0 })
    await new Promise((r) => wss.once('listening', r))
    const port = wss.address().port
    const seenUrls = []
    wss.on('connection', (ws, req) => {
      seenUrls.push(req.url)
    })
    const index = new RecipeIndex(':memory:')
    const ingestor = createIngestor({
      index,
      repoStateProvider: async () => ({ did: 'did:plc:x', records: [] }),
      pdsUrl: `http://127.0.0.1:${port}`,
      log: quietLog,
      firehoseCursorPath: file,
    })
    try {
      expect(ingestor.firehoseSeq).toBe(99)
      ingestor.startFirehose()
      for (let i = 0; i < 50 && seenUrls.length === 0; i++) await sleep(100)
      expect(seenUrls.length).toBeGreaterThanOrEqual(1)
      expect(seenUrls[0]).toContain('cursor=99')
    } finally {
      ingestor.close()
      index.close()
      wss.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a cursor rejected by the PDS (immediate close, nothing received) is dropped once', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-wave4c-cursor4-'))
    const file = path.join(dir, 'firehose-cursor.json')
    saveFirehoseCursor(file, 77)
    const wss = new WebSocketServer({ port: 0 })
    await new Promise((r) => wss.once('listening', r))
    const port = wss.address().port
    const seenUrls = []
    wss.on('connection', (ws, req) => {
      seenUrls.push(req.url)
      // Close shortly after the handshake: the client saw `open` but
      // received nothing — the stale-cursor shape.
      setTimeout(() => {
        try {
          ws.close()
        } catch {
          /* gone */
        }
      }, 50)
    })
    const index = new RecipeIndex(':memory:')
    const ingestor = createIngestor({
      index,
      repoStateProvider: async () => ({ did: 'did:plc:x', records: [] }),
      pdsUrl: `http://127.0.0.1:${port}`,
      log: quietLog,
      firehoseCursorPath: file,
    })
    try {
      ingestor.startFirehose()
      for (let i = 0; i < 100 && seenUrls.length < 2; i++) await sleep(100)
      expect(seenUrls.length).toBeGreaterThanOrEqual(2)
      expect(seenUrls[0]).toContain('cursor=77')
      // The reconnect drops the rejected cursor instead of looping on it.
      expect(seenUrls[1]).not.toContain('cursor=')
      expect(loadFirehoseCursor(file)).toBeNull()
    } finally {
      ingestor.close()
      index.close()
      wss.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 15000)
})
