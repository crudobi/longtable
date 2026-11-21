import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { cidForRecord } from '@atproto/repo'
import { RecipeIndex } from '../db.mjs'
import { createIngestor, validateRecipeRecord, MAX_RECONCILE_RECORDS, MAX_RECONCILE_MS } from '../ingest.mjs'
import { createAppView } from '../server.mjs'
import { createMediaCache, rawCidForBytes } from '../media.mjs'
import { makeDevice, signedRecipeRecord, perDeviceBindingEntry } from './signed-fixtures.mjs'

// Wave 5C — server-side Lows + carried Medium Int M1. Each describe
// pins one item's behavior; the item id is in the describe title.

const DID = 'did:plc:wave5c'
const quietLog = { log() {}, info() {}, warn() {}, error() {} }

function record(name, ingredients, extra = {}) {
  return {
    $type: 'kitchen.longtable.recipe',
    name,
    ingredients,
    instructions: ['Cook it.'],
    longtableId: `lt-${name.toLowerCase().replaceAll(' ', '-')}`,
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
    ...extra,
  }
}

function fakeProvider(state) {
  return async (did) => {
    if (state.error) throw state.error
    return { did, commitCid: 'bafyfakecommit', records: state.records ?? [] }
  }
}

function recipeEntry(rec, cid = `cid-${rec.longtableId}`) {
  // S16: the repo rkey IS the record's longtableId.
  return { collection: 'kitchen.longtable.recipe', rkey: rec.longtableId, cid, record: rec }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------ S15
describe('S15: per-repo reconcile budget (record count and wall time)', () => {
  let index, state, ingestor, device, binding
  const three = () => {
    const a = signedRecipeRecord(device, DID, 'Alpha Soup', ['1 egg'])
    const b = signedRecipeRecord(device, DID, 'Beta Stew', ['2 potatoes'])
    const c = signedRecipeRecord(device, DID, 'Gamma Salad', ['3 leaves'])
    return [a, b, c]
  }

  beforeEach(() => {
    index = new RecipeIndex(':memory:')
    state = { records: [] }
    device = makeDevice()
    binding = perDeviceBindingEntry(device, DID)
  })
  afterEach(() => index.close())

  function ingestorWith(opts = {}) {
    return createIngestor({
      index,
      repoStateProvider: fakeProvider(state),
      pdsUrl: 'http://localhost:2583',
      log: quietLog,
      ...opts,
    })
  }

  it('pins the default budget: 5000 records / 30 s', () => {
    expect(MAX_RECONCILE_RECORDS).toBe(5000)
    expect(MAX_RECONCILE_MS).toBe(30_000)
  })

  it('record cap: stops after the budget, reports it, and skips the sweep', async () => {
    const [a, b, c] = three()
    state.records = [binding, recipeEntry(a), recipeEntry(b), recipeEntry(c)]
    ingestor = ingestorWith({ maxReconcileRecords: 1 })
    const res = await ingestor.reconcileRepo(DID)
    expect(res.ok).toBe(true)
    expect(res.budgetExceeded).toBe(true)
    // processed counts the record that tripped the budget (2 = one
    // handled + the one that stopped the loop).
    expect(res.processed).toBe(2)
    expect(res.sweepSkipped).toBe(true)
    // maxRecords 1 handles exactly one record (Alpha); Beta is the
    // record that trips the budget, Gamma is never reached.
    expect(index.count()).toBe(1)
    expect(index.getRecipe(DID, 'lt-alpha-soup')).not.toBeNull()
    expect(index.getRecipe(DID, 'lt-beta-stew')).toBeNull()
    expect(index.getRecipe(DID, 'lt-gamma-salad')).toBeNull()
    expect(ingestor.stats.budgetExceeded).toBe(1)
  })

  it('time cap: maxMs 0 stops before handling any record', async () => {
    const [a, b] = three()
    state.records = [binding, recipeEntry(a), recipeEntry(b)]
    ingestor = ingestorWith({ maxReconcileMs: 0 })
    const res = await ingestor.reconcileRepo(DID)
    expect(res.budgetExceeded).toBe(true)
    expect(res.processed).toBe(1)
    expect(res.indexed).toBe(0)
    expect(res.sweepSkipped).toBe(true)
    expect(index.count()).toBe(0)
  })

  it('budget stop keeps previously-indexed rows for records it never examined', async () => {
    const [a, b, c] = three()
    state.records = [binding, recipeEntry(a), recipeEntry(b), recipeEntry(c)]
    ingestor = ingestorWith()
    const first = await ingestor.reconcileRepo(DID)
    expect(first.ok).toBe(true)
    expect(index.count()).toBe(3)

    // The author deletes Gamma — but the budget stops the reconcile
    // before it looks at Beta, so `seen` is incomplete and the sweep
    // must NOT run: Gamma's row stays until a full sweep sees it go.
    state.records = [binding, recipeEntry(a), recipeEntry(b)]
    const budgeted = ingestorWith({ maxReconcileRecords: 0 })
    const res = await budgeted.reconcileRepo(DID)
    expect(res.budgetExceeded).toBe(true)
    expect(res.sweepSkipped).toBe(true)
    expect(res.deleted).toBe(0)
    expect(index.count()).toBe(3)
    expect(index.getRecipe(DID, 'lt-gamma-salad')).not.toBeNull()

    // A full reconcile afterwards sweeps Gamma properly.
    const full = await ingestor.reconcileRepo(DID)
    expect(full.budgetExceeded).toBe(false)
    expect(full.deleted).toBe(1)
    expect(index.count()).toBe(2)
  })
})

// ------------------------------------------------------------------ S16
describe('S16: rkey must equal longtableId at ingest', () => {
  let index, state, ingestor, device
  beforeEach(() => {
    index = new RecipeIndex(':memory:')
    state = { records: [] }
    device = makeDevice()
    ingestor = createIngestor({
      index,
      repoStateProvider: fakeProvider(state),
      pdsUrl: 'http://localhost:2583',
      log: quietLog,
    })
  })
  afterEach(() => index.close())

  it('reconcile rejects a record whose rkey is not its longtableId, keeps a valid sibling', async () => {
    const good = signedRecipeRecord(device, DID, 'Beta Stew', ['2 potatoes'])
    const bad = signedRecipeRecord(device, DID, 'Alpha Soup', ['1 egg'])
    state.records = [
      perDeviceBindingEntry(device, DID),
      // A genuinely signed record, published under a foreign rkey.
      { collection: 'kitchen.longtable.recipe', rkey: 'not-the-id', cid: 'cid-bad', record: bad },
      recipeEntry(good),
    ]
    const res = await ingestor.reconcileRepo(DID)
    expect(res.ok).toBe(true)
    expect(res.validationRejected).toBe(1)
    expect(res.rejected).toBe(1)
    expect(ingestor.stats.validationRejected).toBe(1)
    expect(index.count()).toBe(1)
    expect(index.getRecipe(DID, 'lt-alpha-soup')).toBeNull()
    expect(index.getRecipe(DID, 'not-the-id')).toBeNull()
    expect(index.getRecipe(DID, 'lt-beta-stew')).not.toBeNull()
  })

  it('ingestClaim for a foreign-rkey entry in the verified repo is not indexed', async () => {
    const rec = signedRecipeRecord(device, DID, 'Alpha Soup', ['1 egg'])
    const cid = (await cidForRecord(rec)).toString()
    state.records = [
      perDeviceBindingEntry(device, DID),
      { collection: 'kitchen.longtable.recipe', rkey: 'not-the-id', cid, record: rec },
    ]
    const res = await ingestor.ingestClaim({
      did: DID,
      collection: 'kitchen.longtable.recipe',
      rkey: 'not-the-id',
      record: rec,
    })
    expect(res.indexed).toBe(false)
    expect(index.count()).toBe(0)
  })
})

// ------------------------------------------------------------------ S17
describe('S17: replay of a re-put old signed version', () => {
  let index, state, ingestor, device
  beforeEach(() => {
    index = new RecipeIndex(':memory:')
    state = { records: [] }
    device = makeDevice()
    ingestor = createIngestor({
      index,
      repoStateProvider: fakeProvider(state),
      pdsUrl: 'http://localhost:2583',
      log: quietLog,
    })
  })
  afterEach(() => index.close())

  it('a re-put old version is rejected and the current version stays', async () => {
    const v1 = signedRecipeRecord(device, DID, 'Alpha Soup', ['1 egg'])
    const v2 = signedRecipeRecord(device, DID, 'Alpha Soup', ['2 eggs'])
    expect(v1.longtableId).toBe(v2.longtableId)
    const cid2 = (await cidForRecord(v2)).toString()
    state.records = [perDeviceBindingEntry(device, DID), { ...recipeEntry(v2), cid: cid2 }]
    const first = await ingestor.reconcileRepo(DID)
    expect(first.ok).toBe(true)
    expect(index.getRecipe(DID, 'lt-alpha-soup').ingredients).toEqual(['2 eggs'])

    // v1 is genuinely signed and was once the current version — but
    // it is not the repo's current verified state, so the claim fails
    // the CID-equality gate and nothing is re-indexed.
    const replay = await ingestor.ingestClaim({
      did: DID,
      collection: 'kitchen.longtable.recipe',
      rkey: 'lt-alpha-soup',
      record: v1,
    })
    expect(replay.indexed).toBe(false)
    expect(replay.reason).toBe('not-in-verified-repo')
    expect(index.getRecipe(DID, 'lt-alpha-soup').ingredients).toEqual(['2 eggs'])
    expect(index.count()).toBe(1)
  })

  it('re-putting the CURRENT version is indexed (the repo is authoritative)', async () => {
    const v2 = signedRecipeRecord(device, DID, 'Alpha Soup', ['2 eggs'])
    const cid2 = (await cidForRecord(v2)).toString()
    state.records = [perDeviceBindingEntry(device, DID), { ...recipeEntry(v2), cid: cid2 }]
    await ingestor.reconcileRepo(DID)
    const again = await ingestor.ingestClaim({
      did: DID,
      collection: 'kitchen.longtable.recipe',
      rkey: 'lt-alpha-soup',
      record: v2,
    })
    expect(again.indexed).toBe(true)
    expect(index.getRecipe(DID, 'lt-alpha-soup').ingredients).toEqual(['2 eggs'])
  })
})

// ---------------------------------------------------------------- Int M1
describe('Int M1: lexicon/per-record validation on ingest', () => {
  it('validateRecipeRecord accepts a conformant record', () => {
    const ok = record('Valid Soup', ['1 egg'], {
      description: 'Nice.',
      prepTimeMinutes: 5,
      cookTimeMinutes: 10,
      recipeYield: '4 servings',
      tags: ['soup'],
      images: [{ ref: { $link: 'bafyfake' } }, { ref: 'bafyfake2' }],
      deviceSignature: 'c2lnbmF0dXJl',
    })
    expect(validateRecipeRecord(ok)).toBeNull()
  })

  it.each([
    ['not an object', null, 'invalid-record:not-an-object'],
    ['array', [], 'invalid-record:not-an-object'],
    ['bad $type', record('X', [], { $type: 'app.bsky.feed.post' }), 'invalid-record:bad-$type'],
    ['missing $type', record('X', [], { $type: undefined }), 'invalid-record:bad-$type'],
    ['empty name', record('', ['1 egg']), 'invalid-record:bad-name'],
    ['name over 300', record('x'.repeat(301), ['1 egg']), 'invalid-record:bad-name'],
    ['ingredients not an array', record('X', '1 egg'), 'invalid-record:bad-ingredients'],
    ['101 ingredients', record('X', Array(101).fill('egg')), 'invalid-record:bad-ingredients'],
    ['ingredient over 1000', record('X', ['x'.repeat(1001)]), 'invalid-record:bad-ingredients'],
    ['instructions not an array', record('X', [], { instructions: 'cook' }), 'invalid-record:bad-instructions'],
    ['201 instructions', record('X', [], { instructions: Array(201).fill('stir') }), 'invalid-record:bad-instructions'],
    ['instruction over 5000', record('X', [], { instructions: ['x'.repeat(5001)] }), 'invalid-record:bad-instructions'],
    ['bad createdAt', record('X', [], { createdAt: 'not-a-date' }), 'invalid-record:bad-createdAt'],
    ['empty longtableId', record('X', [], { longtableId: '' }), 'invalid-record:bad-longtableId'],
    ['longtableId over 64', record('X', [], { longtableId: 'x'.repeat(65) }), 'invalid-record:bad-longtableId'],
    ['description over 3000', record('X', [], { description: 'x'.repeat(3001) }), 'invalid-record:bad-description'],
    ['fractional minutes', record('X', [], { prepTimeMinutes: 1.5 }), 'invalid-record:bad-minutes'],
    ['negative minutes', record('X', [], { prepTimeMinutes: -1 }), 'invalid-record:bad-minutes'],
    ['minutes over 10080', record('X', [], { cookTimeMinutes: 10081 }), 'invalid-record:bad-minutes'],
    ['string minutes', record('X', [], { cookTimeMinutes: '30' }), 'invalid-record:bad-minutes'],
    ['yield over 100', record('X', [], { recipeYield: 'x'.repeat(101) }), 'invalid-record:bad-yield'],
    ['21 tags', record('X', [], { tags: Array(21).fill('t') }), 'invalid-record:bad-tags'],
    ['tag over 64', record('X', [], { tags: ['x'.repeat(65)] }), 'invalid-record:bad-tags'],
    ['11 images', record('X', [], { images: Array(11).fill({ ref: 'bafy' }) }), 'invalid-record:bad-images'],
    ['image with no ref', record('X', [], { images: [{ nope: 1 }] }), 'invalid-record:bad-images'],
    ['deviceSignature over 256', record('X', [], { deviceSignature: 'x'.repeat(257) }), 'invalid-record:bad-deviceSignature'],
    ['bad updatedAt', record('X', [], { updatedAt: 'garbage' }), 'invalid-record:bad-updatedAt'],
  ])('%s -> %s', (_label, rec, reason) => {
    expect(validateRecipeRecord(rec)).toBe(reason)
  })

  it('reconcile rejects an invalid record, counts it, and indexes its valid sibling', async () => {
    const index = new RecipeIndex(':memory:')
    const state = { records: [] }
    const device = makeDevice()
    const ingestor = createIngestor({
      index,
      repoStateProvider: fakeProvider(state),
      pdsUrl: 'http://localhost:2583',
      log: quietLog,
    })
    try {
      const valid = signedRecipeRecord(device, DID, 'Beta Stew', ['2 potatoes'])
      // No device signature at all and a wrong $type: validation runs
      // before any crypto, so this is a validation reject, not a
      // signature reject.
      const invalid = record('Bad Soup', ['1 egg'], { $type: 'app.bsky.feed.post' })
      state.records = [
        perDeviceBindingEntry(device, DID),
        { collection: 'kitchen.longtable.recipe', rkey: 'lt-bad-soup', cid: 'cid-bad', record: invalid },
        recipeEntry(valid),
      ]
      const res = await ingestor.reconcileRepo(DID)
      expect(res.ok).toBe(true)
      expect(res.validationRejected).toBe(1)
      expect(res.signatureRejected).toBe(0)
      expect(res.rejected).toBe(1)
      expect(index.count()).toBe(1)
      expect(index.getRecipe(DID, 'lt-beta-stew')).not.toBeNull()
      expect(index.getRecipe(DID, 'lt-bad-soup')).toBeNull()
    } finally {
      index.close()
    }
  })
})

// ---------------------------------------------------------------- Int L2
describe('Int L2: search pagination + total', () => {
  let index
  const verifiedRow = (i) => {
    const device = makeDevice()
    return {
      uri: `at://${DID}/kitchen.longtable.recipe/soup-${i}`,
      did: DID,
      rkey: `soup-${i}`,
      cid: `cid-soup-${i}`,
      record: {
        $type: 'kitchen.longtable.recipe',
        name: `Soup ${i}`,
        ingredients: ['water'],
        instructions: ['Boil.'],
        longtableId: `lt-soup-${i}`,
        createdAt: '2026-10-12T00:00:00.000Z',
        deviceDid: device.deviceDid,
        deviceSignature: 'c2lnbmF0dXJl',
      },
      deviceKey: device.devicePublicKey,
    }
  }

  beforeEach(() => {
    index = new RecipeIndex(':memory:')
    for (let i = 0; i < 5; i++) index.upsert(verifiedRow(i))
    // One unverified row (pre-C2, no device fields): it must never
    // count toward a verified total.
    index.upsert({
      uri: `at://${DID}/kitchen.longtable.recipe/soup-x`,
      did: DID,
      rkey: 'soup-x',
      cid: 'cid-soup-x',
      record: {
        $type: 'kitchen.longtable.recipe',
        name: 'Soup X',
        ingredients: ['water'],
        instructions: ['Boil.'],
        longtableId: 'lt-soup-x',
        createdAt: '2026-10-12T00:00:00.000Z',
      },
    })
  })
  afterEach(() => index.close())

  it('search + searchCount agree, and pages are disjoint', () => {
    expect(index.searchCount({ q: 'Soup', verifiedOnly: true })).toBe(5)
    expect(index.search({ q: 'Soup', verifiedOnly: true })).toHaveLength(5)
    const p1 = index.search({ q: 'Soup', verifiedOnly: true, limit: 2, offset: 0 })
    const p2 = index.search({ q: 'Soup', verifiedOnly: true, limit: 2, offset: 2 })
    const p3 = index.search({ q: 'Soup', verifiedOnly: true, limit: 2, offset: 4 })
    expect(p1).toHaveLength(2)
    expect(p2).toHaveLength(2)
    expect(p3).toHaveLength(1)
    const rkeys = [...p1, ...p2, ...p3].map((r) => r.rkey)
    expect(new Set(rkeys).size).toBe(5)
  })

  it('verifiedOnly keeps unverified rows out of the total; the unfiltered view is unchanged', () => {
    expect(index.searchCount({ q: 'Soup' })).toBe(6)
    expect(index.search({ q: 'Soup' })).toHaveLength(6)
    expect(index.searchCount({ q: 'Soup', verifiedOnly: true })).toBe(5)
  })

  it('limit clamps to 100; a negative offset clamps to 0', () => {
    expect(index.search({ q: 'Soup', verifiedOnly: true, limit: 150 })).toHaveLength(5)
    expect(index.search({ q: 'Soup', verifiedOnly: true, offset: -1 })).toHaveLength(5)
  })
})

describe('Int L2: /search HTTP envelope', () => {
  let app, base
  beforeAll(async () => {
    app = createAppView({
      dbPath: ':memory:',
      pdsUrl: 'http://localhost:2583',
      plcUrl: 'http://localhost:2582',
      repoStateProvider: async () => {
        throw new Error('no network in wave5c tests')
      },
      log: quietLog,
    })
    const device = makeDevice()
    for (let i = 0; i < 3; i++) {
      app.index.upsert({
        uri: `at://${DID}/kitchen.longtable.recipe/soup-${i}`,
        did: DID,
        rkey: `soup-${i}`,
        cid: `cid-soup-${i}`,
        record: {
          $type: 'kitchen.longtable.recipe',
          name: `Soup ${i}`,
          ingredients: ['water'],
          instructions: ['Boil.'],
          longtableId: `lt-soup-${i}`,
          createdAt: '2026-10-12T00:00:00.000Z',
          deviceDid: device.deviceDid,
          deviceSignature: 'c2lnbmF0dXJl',
        },
        deviceKey: device.devicePublicKey,
      })
    }
    app.index.upsert({
      uri: `at://${DID}/kitchen.longtable.recipe/soup-x`,
      did: DID,
      rkey: 'soup-x',
      cid: 'cid-soup-x',
      record: {
        $type: 'kitchen.longtable.recipe',
        name: 'Soup X',
        ingredients: ['water'],
        instructions: ['Boil.'],
        longtableId: 'lt-soup-x',
        createdAt: '2026-10-12T00:00:00.000Z',
      },
    })
    const addr = await app.listen(0)
    base = `http://127.0.0.1:${addr.port}`
  })
  afterAll(async () => {
    await app.close()
  })

  it('returns {results, total, limit, offset} and pages to the end', async () => {
    const all = await (await fetch(`${base}/search?q=Soup`)).json()
    expect(all.total).toBe(3)
    expect(all.results).toHaveLength(3)
    expect(all.limit).toBe(100)
    expect(all.offset).toBe(0)
    const p1 = await (await fetch(`${base}/search?q=Soup&limit=2`)).json()
    expect(p1.total).toBe(3)
    expect(p1.results).toHaveLength(2)
    expect(p1.limit).toBe(2)
    const p2 = await (await fetch(`${base}/search?q=Soup&limit=2&offset=2`)).json()
    expect(p2.total).toBe(3)
    expect(p2.results).toHaveLength(1)
    expect(p2.results[0].rkey).not.toBe(p1.results[0].rkey)
  })

  it.each([
    ['limit=0', '/search?q=Soup&limit=0'],
    ['limit=101', '/search?q=Soup&limit=101'],
    ['limit=abc', '/search?q=Soup&limit=abc'],
    ['offset=-1', '/search?q=Soup&offset=-1'],
    ['offset=1.5', '/search?q=Soup&offset=1.5'],
  ])('400s on %s', async (_label, qs) => {
    const res = await fetch(`${base}${qs}`)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(typeof body.error).toBe('string')
  })
})

// --------------------------------------------------------------- Int L10a
describe('Int L10(a): ?q= matches steps too', () => {
  let index
  beforeEach(() => {
    index = new RecipeIndex(':memory:')
    const rows = [
      { uri: `at://${DID}/kitchen.longtable.recipe/a`, rkey: 'a', name: 'Alpha Soup', instructions: ['Simmer slowly for an hour'] },
      { uri: `at://${DID}/kitchen.longtable.recipe/b`, rkey: 'b', name: 'Beta Stew', instructions: ['Boil hard'] },
      { uri: `at://${DID}/kitchen.longtable.recipe/c`, rkey: 'c', name: 'Simmer Pot', instructions: ['Serve cold'] },
    ]
    for (const r of rows) {
      index.upsert({
        uri: r.uri,
        did: DID,
        rkey: r.rkey,
        cid: `cid-${r.rkey}`,
        record: {
          $type: 'kitchen.longtable.recipe',
          name: r.name,
          ingredients: ['water'],
          instructions: r.instructions,
          longtableId: `lt-${r.rkey}`,
          createdAt: '2026-10-12T00:00:00.000Z',
        },
      })
    }
  })
  afterEach(() => index.close())

  it('FTS: a term in the steps matches; multi-word terms AND together', () => {
    // 'simmer' is in A's steps and C's name; 'boil' only in B's steps.
    expect(index.search({ q: 'simmer' }).map((r) => r.rkey).sort()).toEqual(['a', 'c'])
    expect(index.search({ q: 'boil' }).map((r) => r.rkey)).toEqual(['b'])
    expect(index.search({ q: 'simmer slowly' }).map((r) => r.rkey)).toEqual(['a'])
    expect(index.search({ q: 'alpha simmer' }).map((r) => r.rkey)).toEqual(['a'])
    expect(index.search({ q: 'serve cold' }).map((r) => r.rkey)).toEqual(['c'])
    expect(index.searchCount({ q: 'simmer' })).toBe(2)
  })

  it('LIKE fallback (ftsEnabled=false) matches steps with identical results', () => {
    index.ftsEnabled = false
    expect(index.search({ q: 'simmer' }).map((r) => r.rkey).sort()).toEqual(['a', 'c'])
    expect(index.search({ q: 'boil' }).map((r) => r.rkey)).toEqual(['b'])
    expect(index.search({ q: 'simmer slowly' }).map((r) => r.rkey)).toEqual(['a'])
    expect(index.searchCount({ q: 'simmer' })).toBe(2)
  })

  it('migration: an old 3-column FTS table is rebuilt and steps become searchable', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-wave5c-fts-'))
    const dbPath = path.join(dir, 'index.db')
    try {
      const first = new RecipeIndex(dbPath)
      first.upsert({
        uri: `at://${DID}/kitchen.longtable.recipe/a`,
        did: DID,
        rkey: 'a',
        cid: 'cid-a',
        record: {
          $type: 'kitchen.longtable.recipe',
          name: 'Alpha Soup',
          ingredients: ['1 egg'],
          instructions: ['Simmer slowly for an hour'],
          longtableId: 'lt-a',
          createdAt: '2026-10-12T00:00:00.000Z',
        },
      })
      first.close()

      // Rewind the FTS table to the pre-L10(a) schema: 3 columns, no
      // instructions_text, populated the old way.
      const raw = new DatabaseSync(dbPath)
      raw.exec('DROP TABLE recipes_fts')
      raw.exec(`CREATE VIRTUAL TABLE recipes_fts USING fts5(
        uri UNINDEXED, name, ingredients_text, tags_text
      )`)
      raw
        .prepare('INSERT INTO recipes_fts (uri, name, ingredients_text, tags_text) VALUES (?, ?, ?, ?)')
        .run(`at://${DID}/kitchen.longtable.recipe/a`, 'Alpha Soup', '1 egg', '')
      expect(
        raw.prepare('PRAGMA table_info(recipes_fts)').all().map((c) => c.name),
      ).not.toContain('instructions_text')
      raw.close()

      // Reopening migrates: the FTS table is rebuilt from recipes,
      // and the steps term is findable.
      const reopened = new RecipeIndex(dbPath)
      try {
        expect(reopened.search({ q: 'simmer' }).map((r) => r.rkey)).toEqual(['a'])
        expect(reopened.searchCount({ q: 'simmer' })).toBe(1)
        expect(reopened.search({ q: 'slowly' })).toHaveLength(1)
      } finally {
        reopened.close()
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ------------------------------------------------------- media: LRU / tmp
describe('Int L1 / Sec L12: media LRU eviction, .tmp sweep, CID re-verify', () => {
  const DID_M = 'did:plc:wave5c-media'
  const blob = (n) => Buffer.alloc(100, n)
  let dir

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-wave5c-media-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function fetchFor(byCid) {
    return async (url) => {
      const u = new URL(url)
      const cid = u.searchParams.get('cid')
      const entry = byCid[cid]
      if (!entry) return new Response('not found', { status: 404 })
      return new Response(entry, { status: 200, headers: { 'content-type': 'image/png' } })
    }
  }

  it('LRU: a re-read entry survives eviction while a stale one goes', async () => {
    const A = blob(0x41)
    const B = blob(0x42)
    const C = blob(0x43)
    const cidA = rawCidForBytes(A)
    const cidB = rawCidForBytes(B)
    const cidC = rawCidForBytes(C)
    const cache = createMediaCache({
      dir,
      pdsUrl: 'http://pds.test',
      fetchImpl: fetchFor({ [cidA]: A, [cidB]: B, [cidC]: C }),
      log: quietLog,
      // 100-byte blobs + ~80-byte metas: two entries (~360) fit, a
      // third (~540 + 356 incoming) does not.
      maxCacheBytes: 700,
    })
    const sub = path.join(dir, encodeURIComponent(DID_M))
    await cache.get(DID_M, cidA)
    await sleep(10)
    await cache.get(DID_M, cidB)
    await sleep(10)
    // Re-read A: its mtime is now newer than B's.
    const hitA = await cache.get(DID_M, cidA)
    expect(hitA.fromCache).toBe(true)
    await sleep(10)
    await cache.get(DID_M, cidC)
    // FIFO would have evicted A (fetched first); LRU evicts B.
    expect(fs.existsSync(path.join(sub, cidA))).toBe(true)
    expect(fs.existsSync(path.join(sub, cidB))).toBe(false)
    expect(fs.existsSync(path.join(sub, cidC))).toBe(true)
    const refetchB = await cache.get(DID_M, cidB)
    expect(refetchB.fromCache).toBe(false)
    expect(Buffer.from(refetchB.bytes).equals(B)).toBe(true)
  })

  it('startup sweep: .tmp orphans left by a crashed process are gone on creation', () => {
    const sub = path.join(dir, encodeURIComponent(DID_M))
    fs.mkdirSync(sub, { recursive: true })
    const orphan = path.join(sub, 'bafyorphan.tmp-99999')
    fs.writeFileSync(orphan, Buffer.alloc(50, 0x7f))
    expect(fs.existsSync(orphan)).toBe(true)
    const cache = createMediaCache({
      dir,
      pdsUrl: 'http://pds.test',
      fetchImpl: fetchFor({}),
      log: quietLog,
    })
    expect(fs.existsSync(orphan)).toBe(false)
    expect(cache.sweepStaleTmp()).toBe(0)
  })

  it('.tmp orphans count toward the cap: a large orphan forces eviction of a live entry', async () => {
    const A = blob(0x41)
    const B = blob(0x42)
    const cidA = rawCidForBytes(A)
    const cidB = rawCidForBytes(B)
    const cache = createMediaCache({
      dir,
      pdsUrl: 'http://pds.test',
      fetchImpl: fetchFor({ [cidA]: A, [cidB]: B }),
      log: quietLog,
      maxCacheBytes: 1000,
    })
    const sub = path.join(dir, encodeURIComponent(DID_M))
    // A fresh .tmp planted AFTER creation (so the startup sweep does
    // not take it): 800 bytes of orphaned capacity.
    fs.mkdirSync(sub, { recursive: true })
    fs.writeFileSync(path.join(sub, 'bafyorphan.tmp-99999'), Buffer.alloc(800, 0x7f))
    await cache.get(DID_M, cidA)
    expect(fs.existsSync(path.join(sub, cidA))).toBe(true)
    // Storing B: 800 (orphan) + ~180 (A) + 356 incoming > 1000, so A
    // must go. Without .tmp accounting A would survive (180 + 356).
    await cache.get(DID_M, cidB)
    expect(fs.existsSync(path.join(sub, cidA))).toBe(false)
    expect(fs.existsSync(path.join(sub, cidB))).toBe(true)
  })

  it('Sec L12: a cached blob whose bytes no longer hash to its CID is dropped and refetched', async () => {
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const CID = rawCidForBytes(PNG)
    const warnings = []
    const log = { info() {}, error() {}, warn: (m) => warnings.push(String(m)) }
    let fetches = 0
    const cache = createMediaCache({
      dir,
      pdsUrl: 'http://pds.test',
      fetchImpl: async () => {
        fetches++
        return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })
      },
      log,
    })
    const sub = path.join(dir, encodeURIComponent(DID_M))
    const first = await cache.get(DID_M, CID)
    expect(first.fromCache).toBe(false)
    expect(fetches).toBe(1)
    // Corrupt the stored bytes on disk (bit flip / partial write).
    fs.writeFileSync(path.join(sub, CID), Buffer.alloc(PNG.length, 0xee))
    const second = await cache.get(DID_M, CID)
    expect(second).not.toBeNull()
    expect(second.fromCache).toBe(false)
    expect(Buffer.from(second.bytes).equals(PNG)).toBe(true)
    expect(fetches).toBe(2)
    expect(warnings.some((w) => w.includes('CID re-verification'))).toBe(true)
    // The stored file is good again after the refetch.
    expect(Buffer.from(fs.readFileSync(path.join(sub, CID))).equals(PNG)).toBe(true)
  })
})
