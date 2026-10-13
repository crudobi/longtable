import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { cidForRecord } from '@atproto/repo'
import { RecipeIndex } from '../db.mjs'
import { createIngestor, isWantedPath } from '../ingest.mjs'

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
  let index, state, ingestor
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

  it('indexes recipes from the verified state and ignores other collections', async () => {
    state.records = [
      { collection: 'kitchen.longtable.recipe', rkey: 'a', cid: 'cid-a', record: record('Alpha Soup', ['1 egg']) },
      { collection: 'kitchen.longtable.pubkey', rkey: 'self', cid: 'cid-pk', record: { deviceDid: 'did:key:z123' } },
      { collection: 'app.bsky.feed.post', rkey: 'p', cid: 'cid-p', record: { text: 'hi' } },
    ]
    const res = await ingestor.reconcileRepo(DID)
    expect(res.ok).toBe(true)
    expect(index.count()).toBe(1)
    expect(index.search({ q: 'Alpha' })).toHaveLength(1)
    expect(ingestor.stats.indexed).toBe(1)
    expect(ingestor.stats.lastReconcileAt).toBeTruthy()
  })

  it('delete-via-reconcile-diff: a record that vanishes from the repo leaves the index', async () => {
    state.records = [
      { collection: 'kitchen.longtable.recipe', rkey: 'a', cid: 'cid-a', record: record('Alpha Soup', ['1 egg']) },
      { collection: 'kitchen.longtable.recipe', rkey: 'b', cid: 'cid-b', record: record('Beta Stew', ['2 potatoes']) },
    ]
    await ingestor.reconcileRepo(DID)
    expect(index.count()).toBe(2)

    state.records = [state.records[0]] // 'b' deleted in the repo
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
  const genuine = record('Genuine Borscht', ['3 beets', '1 onion'])
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
    state.records = [{ collection: 'kitchen.longtable.recipe', rkey: 'r1', cid, record: genuine }]
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
