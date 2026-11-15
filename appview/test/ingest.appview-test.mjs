import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { cidForRecord } from '@atproto/repo'
import { RecipeIndex } from '../db.mjs'
import { createIngestor, isWantedPath } from '../ingest.mjs'
import { makeDevice, bindingRecord, signedRecipeRecord, signMsg } from './signed-fixtures.mjs'
import { canonicalRecipeHashHex, recipeSignatureMessage, pubkeyBindingMessage } from '../device-signature.mjs'

const DID = 'did:plc:fakeauthor'
const OTHER = 'did:plc:fakeother'

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

/**
 * Fake repo-state provider — the test seam for verify.mjs. In production the
 * provider is createVerifiedRepoProvider (CAR fetch + verifyRepoCar); here
 * tests hand the ingestor a canned "verified" state or make it throw the way
 * a signature failure would.
 */
function fakeProvider(state) {
  return async (did) => {
    if (state.error) throw state.error
    return { did, commitCid: 'bafyfakecommit', records: state.records ?? [] }
  }
}

describe('ingestor reconcile (fake verify seam)', () => {
  let index, state, ingestor, device
  beforeEach(() => {
    index = new RecipeIndex(':memory:')
    state = { records: [] }
    device = makeDevice()
    ingestor = createIngestor({
      index,
      repoStateProvider: fakeProvider(state),
      pdsUrl: 'http://localhost:2583',
      log: { info() {}, warn() {}, error() {} },
    })
  })
  afterEach(() => index.close())

  it('indexes recipes from the verified state and ignores other collections', async () => {
    state.records = [
      { collection: 'kitchen.longtable.recipe', rkey: 'a', cid: 'cid-a', record: signedRecipeRecord(device, DID, 'Alpha Soup', ['1 egg']) },
      { collection: 'kitchen.longtable.pubkey', rkey: 'self', cid: 'cid-pk', record: bindingRecord(device, DID) },
      { collection: 'app.bsky.feed.post', rkey: 'p', cid: 'cid-p', record: { text: 'hi' } },
    ]
    const res = await ingestor.reconcileRepo(DID)
    expect(res.ok).toBe(true)
    expect(index.count()).toBe(1)
    expect(index.search({ q: 'Alpha' })).toHaveLength(1)
    expect(ingestor.stats.indexed).toBe(1)
    expect(ingestor.stats.lastReconcileAt).toBeTruthy()
    // The indexed row carries the signature fields for client verification.
    const row = index.getRecipe(DID, 'a')
    expect(row.deviceDid).toBe(device.deviceDid)
    expect(row.deviceSignature).toBeTruthy()
    expect(row.deviceKey).toBe(device.devicePublicKey)
  })

  it('delete-via-reconcile-diff: a record that vanishes from the repo leaves the index', async () => {
    const binding = { collection: 'kitchen.longtable.pubkey', rkey: 'self', cid: 'cid-pk', record: bindingRecord(device, DID) }
    state.records = [
      { collection: 'kitchen.longtable.recipe', rkey: 'a', cid: 'cid-a', record: signedRecipeRecord(device, DID, 'Alpha Soup', ['1 egg']) },
      { collection: 'kitchen.longtable.recipe', rkey: 'b', cid: 'cid-b', record: signedRecipeRecord(device, DID, 'Beta Stew', ['2 potatoes']) },
      binding,
    ]
    await ingestor.reconcileRepo(DID)
    expect(index.count()).toBe(2)

    state.records = [state.records[0], binding] // 'b' deleted in the repo
    const res = await ingestor.reconcileRepo(DID)
    expect(res.deleted).toBe(1)
    expect(index.count()).toBe(1)
    expect(index.search({ q: 'Beta' })).toHaveLength(0)
    expect(index.search({ q: 'Alpha' })).toHaveLength(1)
  })

  it('reconcile for one DID never deletes another DID\u2019s rows', async () => {
    index.upsert({
      uri: `at://${OTHER}/kitchen.longtable.recipe/x`,
      did: OTHER,
      rkey: 'x',
      cid: 'cid-x',
      record: record('Other Dish', ['rice']),
    })
    state.records = []
    await ingestor.reconcileRepo(DID)
    expect(index.count()).toBe(1)
    expect(index.byAuthor(OTHER)).toHaveLength(1)
  })

  it('verification failure indexes nothing and increments rejected', async () => {
    state.error = new Error('Invalid signature on commit')
    const res = await ingestor.reconcileRepo(DID)
    expect(res.ok).toBe(false)
    expect(index.count()).toBe(0)
    expect(ingestor.stats.rejected).toBe(1)
  })
})

describe('ingestClaim (forge-injection hook)', () => {
  let index, state, ingestor
  const device = makeDevice()
  const genuine = signedRecipeRecord(device, DID, 'Genuine Borscht', ['3 beets', '1 onion'])
  const bindingEntry = { collection: 'kitchen.longtable.pubkey', rkey: 'self', cid: 'cid-pk', record: bindingRecord(device, DID) }
  beforeEach(() => {
    index = new RecipeIndex(':memory:')
    state = { records: [] }
    ingestor = createIngestor({
      index,
      repoStateProvider: fakeProvider(state),
      pdsUrl: 'http://localhost:2583',
      log: { info() {}, warn() {}, error() {} },
    })
  })
  afterEach(() => index.close())

  it('rejects a fabricated record that is not in the verified repo', async () => {
    const res = await ingestor.ingestClaim({
      did: DID,
      collection: 'kitchen.longtable.recipe',
      rkey: 'forged1',
      record: record('Forged Borscht', ['99 beets']),
    })
    expect(res.indexed).toBe(false)
    expect(res.reason).toBe('not-in-verified-repo')
    expect(ingestor.stats.rejected).toBe(1)
    expect(index.search({ q: 'Forged' })).toHaveLength(0)
    expect(index.count()).toBe(0)
  })

  it('rejects a claim whose CID differs even at the same collection/rkey', async () => {
    state.records = [
      { collection: 'kitchen.longtable.recipe', rkey: 'r1', cid: 'cid-something-else', record: genuine },
    ]
    const res = await ingestor.ingestClaim({
      did: DID,
      collection: 'kitchen.longtable.recipe',
      rkey: 'r1',
      record: genuine,
    })
    expect(res.indexed).toBe(false)
    expect(ingestor.stats.rejected).toBe(1)
    expect(index.count()).toBe(0)
  })

  it('accepts a claim that is genuinely in the verified repo (CID equality)', async () => {
    const cid = (await cidForRecord(genuine)).toString()
    state.records = [{ collection: 'kitchen.longtable.recipe', rkey: 'r1', cid, record: genuine }, bindingEntry]
    const res = await ingestor.ingestClaim({
      did: DID,
      collection: 'kitchen.longtable.recipe',
      rkey: 'r1',
      record: genuine,
    })
    expect(res.verified).toBe(true)
    expect(res.indexed).toBe(true)
    expect(ingestor.stats.rejected).toBe(0)
    expect(index.search({ q: 'Genuine' })).toHaveLength(1)
    expect(index.search({ q: 'Genuine' })[0].did).toBe(DID)
  })

  it('rejects when verification itself fails', async () => {
    state.error = new Error('RepoVerificationError: bad signature')
    const res = await ingestor.ingestClaim({
      did: DID,
      collection: 'kitchen.longtable.recipe',
      rkey: 'r1',
      record: genuine,
    })
    expect(res.indexed).toBe(false)
    expect(res.reason).toBe('verification-failed')
    expect(ingestor.stats.rejected).toBe(1)
  })
})


describe('device-signature gate (C2)', () => {
  let index, state, ingestor, device
  beforeEach(() => {
    index = new RecipeIndex(':memory:')
    state = { records: [] }
    device = makeDevice()
    ingestor = createIngestor({
      index,
      repoStateProvider: fakeProvider(state),
      pdsUrl: 'http://localhost:2583',
      log: { info() {}, warn() {}, error() {} },
    })
  })
  afterEach(() => index.close())

  function bindingEntryFor(d) {
    return { collection: 'kitchen.longtable.pubkey', rkey: 'self', cid: 'cid-pk', record: bindingRecord(d, DID) }
  }

  function recipeEntry(rkey, rec, cid = `cid-${rkey}`) {
    return { collection: 'kitchen.longtable.recipe', rkey, cid, record: rec }
  }

  it('drops a recipe when the repo has no pubkey binding, and counts it', async () => {
    state.records = [recipeEntry('a', signedRecipeRecord(device, DID, 'Orphan Soup', ['1 egg']))]
    const res = await ingestor.reconcileRepo(DID)
    expect(res.ok).toBe(true)
    expect(index.count()).toBe(0)
    expect(ingestor.stats.rejected).toBe(1)
    expect(ingestor.stats.signatureRejected).toBe(1)
    expect(res.signatureRejected).toBe(1)
  })

  it('drops every recipe when the binding signature is invalid', async () => {
    const bad = bindingRecord(device, DID)
    const attacker = makeDevice()
    bad.signature = signMsg(attacker, pubkeyBindingMessage(DID, device.deviceDid, device.devicePublicKey))
    state.records = [
      recipeEntry('a', signedRecipeRecord(device, DID, 'Alpha Soup', ['1 egg'])),
      { collection: 'kitchen.longtable.pubkey', rkey: 'self', cid: 'cid-pk', record: bad },
    ]
    await ingestor.reconcileRepo(DID)
    expect(index.count()).toBe(0)
    expect(ingestor.stats.signatureRejected).toBe(1)
  })

  it('drops a tampered record (genuine signature, altered content) but keeps its valid sibling', async () => {
    const good = signedRecipeRecord(device, DID, 'Good Soup', ['1 egg'])
    const tampered = signedRecipeRecord(device, DID, 'Tampered Soup', ['1 egg'])
    tampered.ingredients = ['1 egg', '1 cup motor oil']
    state.records = [
      recipeEntry('good', good),
      recipeEntry('bad', tampered),
      bindingEntryFor(device),
    ]
    const res = await ingestor.reconcileRepo(DID)
    expect(res.ok).toBe(true)
    expect(index.count()).toBe(1)
    expect(index.search({ q: 'Good' })).toHaveLength(1)
    expect(index.search({ q: 'Tampered' })).toHaveLength(0)
    expect(ingestor.stats.signatureRejected).toBe(1)
    expect(res.rejected).toBe(1)
  })

  it('drops a recipe re-signed by an attacker key', async () => {
    const attacker = makeDevice()
    const record = signedRecipeRecord(device, DID, 'Resigned Soup', ['1 egg'])
    const hashHex = canonicalRecipeHashHex(record)
    record.deviceSignature = signMsg(attacker, recipeSignatureMessage(DID, record.longtableId, hashHex))
    state.records = [recipeEntry('a', record), bindingEntryFor(device)]
    await ingestor.reconcileRepo(DID)
    expect(index.count()).toBe(0)
    expect(ingestor.stats.signatureRejected).toBe(1)
  })

  it('drops a recipe with no device signature at all', async () => {
    const record = signedRecipeRecord(device, DID, 'Unsigned Soup', ['1 egg'])
    delete record.deviceSignature
    state.records = [recipeEntry('a', record), bindingEntryFor(device)]
    await ingestor.reconcileRepo(DID)
    expect(index.count()).toBe(0)
    expect(ingestor.stats.signatureRejected).toBe(1)
  })

  it('rebinding to a new device deletes recipes signed by the old device', async () => {
    const recipe = signedRecipeRecord(device, DID, 'Alpha Soup', ['1 egg'])
    state.records = [recipeEntry('a', recipe), bindingEntryFor(device)]
    await ingestor.reconcileRepo(DID)
    expect(index.count()).toBe(1)

    const newDevice = makeDevice()
    state.records = [
      recipeEntry('a', recipe),
      { collection: 'kitchen.longtable.pubkey', rkey: 'self', cid: 'cid-pk2', record: bindingRecord(newDevice, DID) },
    ]
    const res = await ingestor.reconcileRepo(DID)
    expect(res.ok).toBe(true)
    expect(index.count()).toBe(0)
    expect(ingestor.stats.signatureRejected).toBe(1)
  })

  it('ingestClaim: a tampered record present in the verified repo is dropped as device-signature-rejected', async () => {
    const tampered = signedRecipeRecord(device, DID, 'Genuine Borscht', ['3 beets', '1 onion'])
    tampered.ingredients = [...tampered.ingredients, '1 cup motor oil']
    const cid = (await cidForRecord(tampered)).toString()
    state.records = [
      { collection: 'kitchen.longtable.recipe', rkey: 'r1', cid, record: tampered },
      bindingEntryFor(device),
    ]
    const res = await ingestor.ingestClaim({
      did: DID,
      collection: 'kitchen.longtable.recipe',
      rkey: 'r1',
      record: tampered,
    })
    expect(res.indexed).toBe(false)
    expect(res.reason).toBe('device-signature-rejected')
    expect(ingestor.stats.signatureRejected).toBe(1)
    expect(index.count()).toBe(0)
  })
})

describe('firehose filtering', () => {
  it('only kitchen.longtable.recipe/ and kitchen.longtable.pubkey/ paths are wanted', () => {
    expect(isWantedPath('kitchen.longtable.recipe/abc')).toBe(true)
    expect(isWantedPath('kitchen.longtable.pubkey/self')).toBe(true)
    expect(isWantedPath('app.bsky.feed.post/abc')).toBe(false)
    expect(isWantedPath('kitchen.longtable.recipeevil/abc')).toBe(false)
    expect(isWantedPath('kitchen.longtable.recipe')).toBe(true)
    expect(isWantedPath(undefined)).toBe(false)
  })

  it('handleFrame ignores commits with no wanted ops and reconciles wanted ones', async () => {
    const index = new RecipeIndex(':memory:')
    const seen = []
    const ingestor = createIngestor({
      index,
      repoStateProvider: async (did) => {
        seen.push(did)
        return { did, records: [] }
      },
      pdsUrl: 'http://localhost:2583',
      log: { info() {}, warn() {}, error() {} },
    })
    expect(
      ingestor.handleFrame(
        { op: 1, t: '#commit' },
        { repo: DID, ops: [{ action: 'create', path: 'app.bsky.feed.post/x', cid: null }] },
      ),
    ).toBe(false)
    expect(
      ingestor.handleFrame(
        { op: 1, t: '#commit' },
        { repo: DID, ops: [{ action: 'create', path: 'kitchen.longtable.recipe/x', cid: null }] },
      ),
    ).toBe(true)
    await ingestor.pending
    expect(seen).toEqual([DID])
    index.close()
  })
})
