import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { RecipeIndex } from '../db.mjs'
import { makeDevice } from './signed-fixtures.mjs'

const DID = 'did:plc:testauthor'

function recipe(rkey, name, ingredients, extra = {}) {
  return {
    uri: `at://${DID}/kitchen.longtable.recipe/${rkey}`,
    did: DID,
    rkey,
    cid: `cid-${rkey}-v1`,
    record: {
      $type: 'kitchen.longtable.recipe',
      name,
      ingredients,
      instructions: ['Cook it.'],
      tags: ['test'],
      longtableId: `lt-${rkey}`,
      createdAt: '2026-10-12T00:00:00.000Z',
      updatedAt: '2026-10-12T00:00:00.000Z',
      ...extra,
    },
  }
}

describe('RecipeIndex search', () => {
  let index
  beforeEach(() => {
    index = new RecipeIndex(':memory:')
    index.upsert(recipe('pancakes', 'Fluffy Pancakes', ['1 egg', '200g flour', '300ml milk']))
    index.upsert(recipe('borscht', 'AppView Borscht', ['3 beets', '1 onion']))
    index.upsert(recipe('omelette', 'Plain Omelette', ['2 eggs', '1 tbsp butter']))
  })
  afterEach(() => index.close())

  it('reports FTS5 availability (expected on this box)', () => {
    // Fallback LIKE search has identical semantics; this records which path ran.
    expect(typeof index.ftsEnabled).toBe('boolean')
  })

  it('finds recipes by name terms', () => {
    const hits = index.search({ q: 'Borscht' })
    expect(hits.map((h) => h.rkey)).toEqual(['borscht'])
    expect(hits[0].did).toBe(DID)
    expect(hits[0].name).toBe('AppView Borscht')
  })

  it('name search is case-insensitive and matches nothing bogus', () => {
    expect(index.search({ q: 'borscht' })).toHaveLength(1)
    expect(index.search({ q: 'sushi' })).toHaveLength(0)
  })

  it('ingredient search uses AND semantics', () => {
    const both = index.search({ ingredients: ['egg', 'flour'] })
    expect(both.map((h) => h.rkey)).toEqual(['pancakes'])
    const missing = index.search({ ingredients: ['egg', 'rice'] })
    expect(missing).toHaveLength(0)
  })

  it('ingredient search matches whole ingredients from a comma-style list', () => {
    const hits = index.search({ ingredients: ['beets', 'onion'] })
    expect(hits.map((h) => h.rkey)).toEqual(['borscht'])
  })

  it('combines name and ingredient filters', () => {
    expect(index.search({ q: 'Pancakes', ingredients: ['flour'] })).toHaveLength(1)
    expect(index.search({ q: 'Pancakes', ingredients: ['beets'] })).toHaveLength(0)
  })

  it('upsert with a new CID replaces; same CID is a no-op; delete removes', () => {
    expect(index.upsert(recipe('borscht', 'AppView Borscht', ['3 beets', '1 onion']))).toBe(false)
    const changed = recipe('borscht', 'AppView Borscht Deluxe', ['4 beets'])
    changed.cid = 'cid-borscht-v2'
    expect(index.upsert(changed)).toBe(true)
    expect(index.search({ q: 'Deluxe' })).toHaveLength(1)
    expect(index.deleteByUri(changed.uri)).toBe(true)
    expect(index.search({ q: 'Borscht' })).toHaveLength(0)
    expect(index.count()).toBe(2)
  })

  it('getRecipe returns the full record, byAuthor lists summaries', () => {
    const full = index.getRecipe(DID, 'borscht')
    expect(full.name).toBe('AppView Borscht')
    expect(full.ingredients).toEqual(['3 beets', '1 onion'])
    expect(full.longtableId).toBe('lt-borscht')
    expect(index.getRecipe(DID, 'nope')).toBeNull()
    expect(index.byAuthor(DID)).toHaveLength(3)
    expect(index.byAuthor('did:plc:someoneelse')).toHaveLength(0)
  })
})

describe('RecipeIndex device-signature fields', () => {
  let index
  beforeEach(() => {
    index = new RecipeIndex(':memory:')
  })
  afterEach(() => index.close())

  it('round-trips deviceDid/deviceSignature/deviceKey through getRecipe, search and byAuthor', () => {
    const device = makeDevice()
    index.upsert({
      uri: `at://${DID}/kitchen.longtable.recipe/signed`,
      did: DID,
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
    const full = index.getRecipe(DID, 'signed')
    expect(full.deviceDid).toBe(device.deviceDid)
    expect(full.deviceSignature).toBe('c2lnbmF0dXJl')
    expect(full.deviceKey).toBe(device.devicePublicKey)
    const hit = index.search({ q: 'Signed Soup' })[0]
    expect(hit.deviceDid).toBe(device.deviceDid)
    expect(hit.deviceSignature).toBe('c2lnbmF0dXJl')
    expect(hit.deviceKey).toBe(device.devicePublicKey)
    expect(index.byAuthor(DID)[0].deviceDid).toBe(device.deviceDid)
  })

  it('same CID with changed signature fields updates the row (no stale NULLs)', () => {
    const entry = recipe('borscht', 'AppView Borscht', ['3 beets', '1 onion'])
    expect(index.upsert(entry)).toBe(true)
    expect(index.getRecipe(DID, 'borscht').deviceKey).toBeNull()
    const device = makeDevice()
    const withSig = recipe('borscht', 'AppView Borscht', ['3 beets', '1 onion'])
    withSig.record.deviceDid = device.deviceDid
    withSig.record.deviceSignature = 'c2lnbmF0dXJl'
    withSig.deviceKey = device.devicePublicKey
    expect(index.upsert(withSig)).toBe(true)
    expect(index.getRecipe(DID, 'borscht').deviceKey).toBe(device.devicePublicKey)
    expect(index.getRecipe(DID, 'borscht').deviceDid).toBe(device.deviceDid)
    expect(index.upsert(withSig)).toBe(false)
  })
})

describe('RecipeIndex summaries carry longtableId (S10)', () => {
  let index
  beforeEach(() => {
    index = new RecipeIndex(':memory:')
  })
  afterEach(() => index.close())

  it('search and byAuthor summaries include the record longtableId', () => {
    const device = makeDevice()
    index.upsert({
      uri: `at://${DID}/kitchen.longtable.recipe/signed`,
      did: DID,
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
    expect(index.search({ q: 'Signed Soup' })[0].longtableId).toBe('lt-signed')
    expect(index.byAuthor(DID)[0].longtableId).toBe('lt-signed')
    // A record with no longtableId at all serves null, not a crash.
    index.upsert({
      uri: `at://${DID}/kitchen.longtable.recipe/noid`,
      did: DID,
      rkey: 'noid',
      cid: 'cid-noid-v1',
      record: {
        $type: 'kitchen.longtable.recipe',
        name: 'No Id Soup',
        ingredients: ['1 egg'],
        instructions: ['Cook it.'],
        createdAt: '2026-10-12T00:00:00.000Z',
      },
    })
    expect(index.search({ q: 'No Id Soup' })[0].longtableId).toBeNull()
  })
})

describe('RecipeIndex DID listing + unverified count (N1 / S2)', () => {
  let index
  beforeEach(() => {
    index = new RecipeIndex(':memory:')
  })
  afterEach(() => index.close())

  it('listDids returns each distinct DID once; countUnverified counts NULL-signature rows', () => {
    const other = 'did:plc:otherauthor'
    index.upsert(recipe('pancakes', 'Fluffy Pancakes', ['1 egg']))
    index.upsert(recipe('borscht', 'AppView Borscht', ['3 beets', '1 onion']))
    index.upsert({
      uri: `at://${other}/kitchen.longtable.recipe/signed`,
      did: other,
      rkey: 'signed',
      cid: 'cid-signed-v1',
      record: {
        $type: 'kitchen.longtable.recipe',
        name: 'Signed Soup',
        ingredients: ['1 egg'],
        instructions: ['Cook it.'],
        longtableId: 'lt-signed',
        createdAt: '2026-10-12T00:00:00.000Z',
        deviceDid: 'did:key:zFakeDevice',
        deviceSignature: 'c2lnbmF0dXJl',
      },
      deviceKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    })
    expect(index.listDids().sort()).toEqual([DID, other].sort())
    // The two unsigned rows are unverified; the signed row is not.
    expect(index.countUnverified()).toBe(2)
    expect(index.count()).toBe(3)
  })

  it('listDids is empty and countUnverified is 0 on an empty index', () => {
    expect(index.listDids()).toEqual([])
    expect(index.countUnverified()).toBe(0)
  })
})
