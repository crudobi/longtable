import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { cidForRecord } from '@atproto/repo'
import { RecipeIndex } from '../db.mjs'
import { createIngestor, isWantedPath } from '../ingest.mjs'
import { makeDevice, bindingRecord, signedRecipeRecord, signMsg, perDeviceBindingEntry, legacyBindingEntry } from './signed-fixtures.mjs'
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
    // The attacker signs the CURRENT (v2) message with their own key:
    // the rejection must come from the wrong key, not a stale message.
    record.deviceSignature = signMsg(
      attacker,
      recipeSignatureMessage(DID, record.longtableId, hashHex, record.createdAt),
    )
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

  it('rebinding to a new device keeps recipes signed by the old device (H-N1)', async () => {
    // Device A publishes first (per-device binding, as the client does now).
    const recipeA = signedRecipeRecord(device, DID, 'Alpha Soup', ['1 egg'])
    state.records = [recipeEntry('a', recipeA), perDeviceBindingEntry(device, DID, 'cid-pk-a')]
    await ingestor.reconcileRepo(DID)
    expect(index.count()).toBe(1)

    // Device B publishes: it ADDS its own per-device binding — it never
    // overwrites A's. Both devices' recipes must stay indexed.
    const newDevice = makeDevice()
    const recipeB = signedRecipeRecord(newDevice, DID, 'Beta Stew', ['2 potatoes'])
    state.records = [
      recipeEntry('a', recipeA),
      recipeEntry('b', recipeB),
      perDeviceBindingEntry(device, DID, 'cid-pk-a'),
      perDeviceBindingEntry(newDevice, DID, 'cid-pk-b'),
    ]
    const res = await ingestor.reconcileRepo(DID)
    expect(res.ok).toBe(true)
    expect(res.bindings).toBe(2)
    expect(index.count()).toBe(2)
    expect(index.search({ q: 'Alpha' })).toHaveLength(1)
    expect(index.search({ q: 'Beta' })).toHaveLength(1)
    expect(ingestor.stats.signatureRejected).toBe(0)
  })

  it('deleting one device binding drops only that device recipes (revocation)', async () => {
    const newDevice = makeDevice()
    state.records = [
      recipeEntry('a', signedRecipeRecord(device, DID, 'Alpha Soup', ['1 egg'])),
      recipeEntry('b', signedRecipeRecord(newDevice, DID, 'Beta Stew', ['2 potatoes'])),
      perDeviceBindingEntry(device, DID, 'cid-pk-a'),
      perDeviceBindingEntry(newDevice, DID, 'cid-pk-b'),
    ]
    await ingestor.reconcileRepo(DID)
    expect(index.count()).toBe(2)

    // Device A's binding is deleted from the repo (revocation): A's rows
    // leave, B's stay — the sweep is per-device now.
    state.records = [
      recipeEntry('a', signedRecipeRecord(device, DID, 'Alpha Soup', ['1 egg'])),
      recipeEntry('b', signedRecipeRecord(newDevice, DID, 'Beta Stew', ['2 potatoes'])),
      perDeviceBindingEntry(newDevice, DID, 'cid-pk-b'),
    ]
    const res = await ingestor.reconcileRepo(DID)
    expect(res.ok).toBe(true)
    expect(index.count()).toBe(1)
    expect(index.search({ q: 'Alpha' })).toHaveLength(0)
    expect(index.search({ q: 'Beta' })).toHaveLength(1)
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

describe('per-device bindings (H-N1)', () => {
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

  function recipeEntry(rkey, rec, cid = `cid-${rkey}`) {
    return { collection: 'kitchen.longtable.recipe', rkey, cid, record: rec }
  }

  it('two devices publish and both recipes stay indexed through flip-flopping reconciles', async () => {
    const other = makeDevice()
    const recA = signedRecipeRecord(device, DID, 'Alpha Soup', ['1 egg'])
    const recB = signedRecipeRecord(other, DID, 'Beta Stew', ['2 potatoes'])
    const both = [
      recipeEntry('a', recA),
      recipeEntry('b', recB),
      perDeviceBindingEntry(device, DID, 'cid-pk-a'),
      perDeviceBindingEntry(other, DID, 'cid-pk-b'),
    ]
    // A publishes, then B publishes, then A publishes again — the old
    // single-slot world un-published the other device on every flip.
    // Here the repo accumulates both bindings, so every reconcile keeps both.
    state.records = [recipeEntry('a', recA), perDeviceBindingEntry(device, DID, 'cid-pk-a')]
    await ingestor.reconcileRepo(DID)
    expect(index.count()).toBe(1)
    state.records = both
    await ingestor.reconcileRepo(DID)
    expect(index.count()).toBe(2)
    // Flip-flop: same state, bindings in the other order, again and again.
    state.records = [...both].reverse()
    await ingestor.reconcileRepo(DID)
    expect(index.count()).toBe(2)
    state.records = both
    const res = await ingestor.reconcileRepo(DID)
    expect(res.ok).toBe(true)
    expect(res.bindings).toBe(2)
    expect(index.count()).toBe(2)
    expect(index.search({ q: 'Alpha' })).toHaveLength(1)
    expect(index.search({ q: 'Beta' })).toHaveLength(1)
    expect(ingestor.stats.signatureRejected).toBe(0)
  })

  it('each indexed row carries its own device key (not the other device key)', async () => {
    const other = makeDevice()
    state.records = [
      recipeEntry('a', signedRecipeRecord(device, DID, 'Alpha Soup', ['1 egg'])),
      recipeEntry('b', signedRecipeRecord(other, DID, 'Beta Stew', ['2 potatoes'])),
      perDeviceBindingEntry(device, DID, 'cid-pk-a'),
      perDeviceBindingEntry(other, DID, 'cid-pk-b'),
    ]
    await ingestor.reconcileRepo(DID)
    expect(index.getRecipe(DID, 'a').deviceKey).toBe(device.devicePublicKey)
    expect(index.getRecipe(DID, 'a').deviceDid).toBe(device.deviceDid)
    expect(index.getRecipe(DID, 'b').deviceKey).toBe(other.devicePublicKey)
    expect(index.getRecipe(DID, 'b').deviceDid).toBe(other.deviceDid)
  })

  it('migration: the legacy self binding still verifies its recipes', async () => {
    state.records = [
      recipeEntry('a', signedRecipeRecord(device, DID, 'Alpha Soup', ['1 egg'])),
      legacyBindingEntry(device, DID),
    ]
    const res = await ingestor.reconcileRepo(DID)
    expect(res.ok).toBe(true)
    expect(res.bindings).toBe(1)
    expect(res.bindingReason).toBeNull()
    expect(index.count()).toBe(1)
    expect(index.getRecipe(DID, 'a').deviceKey).toBe(device.devicePublicKey)
  })

  it('self plus a per-device binding for the same device deduplicate to one binding', async () => {
    state.records = [
      recipeEntry('a', signedRecipeRecord(device, DID, 'Alpha Soup', ['1 egg'])),
      legacyBindingEntry(device, DID, 'cid-pk-self'),
      perDeviceBindingEntry(device, DID, 'cid-pk-dev'),
    ]
    const res = await ingestor.reconcileRepo(DID)
    expect(res.ok).toBe(true)
    expect(res.bindings).toBe(1)
    expect(index.count()).toBe(1)
  })

  it('a binding at an unexpected rkey is ignored and its recipes are dropped', async () => {
    state.records = [
      recipeEntry('a', signedRecipeRecord(device, DID, 'Alpha Soup', ['1 egg'])),
      {
        collection: 'kitchen.longtable.pubkey',
        rkey: 'weird',
        cid: 'cid-pk-weird',
        record: bindingRecord(device, DID),
      },
    ]
    const res = await ingestor.reconcileRepo(DID)
    expect(res.ok).toBe(true)
    expect(res.bindings).toBe(0)
    expect(res.bindingReason).toBe('missing-binding')
    expect(index.count()).toBe(0)
    expect(ingestor.stats.signatureRejected).toBe(1)
  })

  it('a recipe for an unbound device is dropped while a bound device recipes stay', async () => {
    const other = makeDevice()
    state.records = [
      recipeEntry('a', signedRecipeRecord(device, DID, 'Alpha Soup', ['1 egg'])),
      recipeEntry('b', signedRecipeRecord(other, DID, 'Beta Stew', ['2 potatoes'])),
      perDeviceBindingEntry(other, DID, 'cid-pk-b'),
    ]
    const res = await ingestor.reconcileRepo(DID)
    expect(res.ok).toBe(true)
    expect(res.bindings).toBe(1)
    expect(res.bindingReason).toBeNull()
    expect(index.count()).toBe(1)
    expect(index.search({ q: 'Alpha' })).toHaveLength(0)
    expect(index.search({ q: 'Beta' })).toHaveLength(1)
    expect(ingestor.stats.signatureRejected).toBe(1)
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

describe('binding-failure sweep rule (N1 / M-N5)', () => {
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

  async function indexVerified() {
    state.records = [
      recipeEntry('a', signedRecipeRecord(device, DID, 'Alpha Soup', ['1 egg'])),
      bindingEntryFor(device),
    ]
    await ingestor.reconcileRepo(DID)
    expect(index.count()).toBe(1)
  }

  it('missing binding keeps previously-indexed rows (sweep skipped) but rejects new records', async () => {
    await indexVerified()
    // The binding vanishes while the recipe is still in the repo state
    // (e.g. its commit has not arrived yet): the gap is ambiguous.
    state.records = [recipeEntry('a', signedRecipeRecord(device, DID, 'Alpha Soup', ['1 egg']))]
    const res = await ingestor.reconcileRepo(DID)
    expect(res.ok).toBe(true)
    expect(res.sweepSkipped).toBe(true)
    expect(res.bindingReason).toBe('missing-binding')
    expect(res.deleted).toBe(0)
    expect(index.count()).toBe(1)
    expect(index.search({ q: 'Alpha' })).toHaveLength(1)
    expect(ingestor.stats.signatureRejected).toBe(1)
    expect(ingestor.stats.sweepSkipped).toBe(1)
  })

  it('invalid binding signature still sweeps previously-indexed rows', async () => {
    await indexVerified()
    const bad = bindingRecord(device, DID)
    const attacker = makeDevice()
    bad.signature = signMsg(attacker, pubkeyBindingMessage(DID, device.deviceDid, device.devicePublicKey))
    state.records = [
      recipeEntry('a', signedRecipeRecord(device, DID, 'Alpha Soup', ['1 egg'])),
      { collection: 'kitchen.longtable.pubkey', rkey: 'self', cid: 'cid-pk', record: bad },
    ]
    const res = await ingestor.reconcileRepo(DID)
    expect(res.sweepSkipped).toBe(false)
    expect(res.bindingReason).toBe('binding-signature-invalid')
    expect(index.count()).toBe(0)
  })

  it('verified-empty repo still sweeps even with no binding (author deletion)', async () => {
    await indexVerified()
    state.records = []
    const res = await ingestor.reconcileRepo(DID)
    expect(res.sweepSkipped).toBe(false)
    expect(res.bindingReason).toBe('missing-binding')
    expect(res.deleted).toBe(1)
    expect(index.count()).toBe(0)
  })
})

describe('periodic reconcile sweep (N1 / S2)', () => {
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

  it('reconcileAllDids re-indexes a DID whose binding healed, without a new author commit', async () => {
    state.records = [
      recipeEntry('a', signedRecipeRecord(device, DID, 'Alpha Soup', ['1 egg'])),
      bindingEntryFor(device),
    ]
    await ingestor.reconcileRepo(DID)
    expect(index.count()).toBe(1)
    // Binding goes missing: A is rejected but kept (sweep skipped).
    state.records = [recipeEntry('a', signedRecipeRecord(device, DID, 'Alpha Soup', ['1 egg']))]
    const missing = await ingestor.reconcileRepo(DID)
    expect(missing.sweepSkipped).toBe(true)
    expect(index.count()).toBe(1)
    // Binding heals AND a new recipe B appears — no firehose event fires.
    // The sweep alone must pick both up.
    state.records = [
      recipeEntry('a', signedRecipeRecord(device, DID, 'Alpha Soup', ['1 egg'])),
      recipeEntry('b', signedRecipeRecord(device, DID, 'Beta Stew', ['2 potatoes'])),
      bindingEntryFor(device),
    ]
    const results = await ingestor.reconcileAllDids()
    expect(results).toHaveLength(1)
    expect(results[0].did).toBe(DID)
    expect(results[0].ok).toBe(true)
    expect(index.count()).toBe(2)
    expect(index.search({ q: 'Beta' })).toHaveLength(1)
    expect(index.search({ q: 'Alpha' })).toHaveLength(1)
  })

  it('reconcileAllDids backfills a pre-C2 NULL-signature row once its DID re-verifies (S2)', async () => {
    // A row indexed before C2: no device fields at all.
    index.upsert({
      uri: `at://${DID}/kitchen.longtable.recipe/a`,
      did: DID,
      rkey: 'a',
      cid: 'cid-a',
      record: record('Alpha Soup', ['1 egg']),
    })
    expect(index.getRecipe(DID, 'a').deviceKey).toBeNull()
    expect(index.countUnverified()).toBe(1)
    state.records = [
      recipeEntry('a', signedRecipeRecord(device, DID, 'Alpha Soup', ['1 egg'])),
      bindingEntryFor(device),
    ]
    await ingestor.reconcileAllDids()
    const row = index.getRecipe(DID, 'a')
    expect(row.deviceKey).toBe(device.devicePublicKey)
    expect(row.deviceDid).toBe(device.deviceDid)
    expect(row.deviceSignature).toBeTruthy()
    expect(index.countUnverified()).toBe(0)
  })

  it('reconcileAllDids isolates one failing DID and never throws', async () => {
    const throwing = createIngestor({
      index,
      repoStateProvider: async (did) => {
        if (did === OTHER) throw new Error('PDS down')
        return { did, commitCid: 'bafyfakecommit', records: state.records }
      },
      pdsUrl: 'http://localhost:2583',
      log: { info() {}, warn() {}, error() {} },
    })
    index.upsert({
      uri: `at://${OTHER}/kitchen.longtable.recipe/x`,
      did: OTHER,
      rkey: 'x',
      cid: 'cid-x',
      record: record('Other Dish', ['rice']),
    })
    // DID must already have a row for the sweep to visit it.
    index.upsert({
      uri: `at://${DID}/kitchen.longtable.recipe/a`,
      did: DID,
      rkey: 'a',
      cid: 'cid-a',
      record: record('Alpha Soup', ['1 egg']),
    })
    state.records = [
      recipeEntry('a', signedRecipeRecord(device, DID, 'Alpha Soup', ['1 egg'])),
      bindingEntryFor(device),
    ]
    const results = await throwing.reconcileAllDids()
    expect(results).toHaveLength(2)
    const byDid = Object.fromEntries(results.map((r) => [r.did, r]))
    expect(byDid[DID].ok).toBe(true)
    expect(byDid[OTHER].ok).toBe(false)
    // Neither DID's rows were swept by the other's failure.
    expect(index.count()).toBe(2)
  })

  it('startPeriodicReconcile runs the sweep on a timer; stopPeriodicReconcile ends it', async () => {
    let calls = 0
    const timerIngestor = createIngestor({
      index,
      repoStateProvider: async (did) => {
        calls++
        return { did, records: [] }
      },
      pdsUrl: 'http://localhost:2583',
      log: { info() {}, warn() {}, error() {} },
    })
    index.upsert({
      uri: `at://${DID}/kitchen.longtable.recipe/a`,
      did: DID,
      rkey: 'a',
      cid: 'cid-a',
      record: record('Alpha Soup', ['1 egg']),
    })
    timerIngestor.startPeriodicReconcile(10)
    await new Promise((r) => setTimeout(r, 50))
    timerIngestor.stopPeriodicReconcile()
    const callsAfterStop = calls
    await new Promise((r) => setTimeout(r, 40))
    expect(calls).toBeGreaterThan(0)
    expect(calls).toBe(callsAfterStop)
  })
})

describe('ingestClaim queue routing (S12)', () => {
  let index, device, ingestor
  beforeEach(() => {
    index = new RecipeIndex(':memory:')
    device = makeDevice()
  })
  afterEach(() => index.close())

  it('a slow stale reconcile queued ahead of a fast fresh one cannot delete the fresh record', async () => {
    const binding = { collection: 'kitchen.longtable.pubkey', rkey: 'self', cid: 'cid-pk', record: bindingRecord(device, DID) }
    const recA = signedRecipeRecord(device, DID, 'Alpha Soup', ['1 egg'])
    const recB = signedRecipeRecord(device, DID, 'Beta Stew', ['2 potatoes'])
    const cidB = (await cidForRecord(recB)).toString()
    const v1 = [
      { collection: 'kitchen.longtable.recipe', rkey: 'a', cid: 'cid-a', record: recA },
      binding,
    ]
    const v2 = [
      ...v1,
      { collection: 'kitchen.longtable.recipe', rkey: 'b', cid: cidB, record: recB },
    ]
    let version = 'v1'
    const provider = async (did) => {
      // Snapshot the state at call time; a v1 fetch is slow (30 ms),
      // a v2 fetch is fast — without queueing, the slow v1 reconcile
      // finishes last and its sweep deletes B.
      const snap = version === 'v1' ? v1 : v2
      if (version === 'v1') await new Promise((r) => setTimeout(r, 30))
      return { did, commitCid: 'bafyfakecommit', records: snap }
    }
    ingestor = createIngestor({
      index,
      repoStateProvider: provider,
      pdsUrl: 'http://localhost:2583',
      log: { info() {}, warn() {}, error() {} },
    })
    // A firehose commit for A queues a (slow, stale) v1 reconcile...
    expect(
      ingestor.handleFrame(
        { op: 1, t: '#commit' },
        { repo: DID, ops: [{ action: 'create', path: 'kitchen.longtable.recipe/a', cid: null }] },
      ),
    ).toBe(true)
    // ...let it start (snapshot v1) before the repo moves on...
    await new Promise((r) => setTimeout(r, 0))
    version = 'v2'
    // ...then a claim for B arrives. Its reconcile must queue behind
    // the v1 one, not run alongside it.
    const claimed = await ingestor.ingestClaim({
      did: DID,
      collection: 'kitchen.longtable.recipe',
      rkey: 'b',
      record: recB,
    })
    await ingestor.pending
    expect(claimed.indexed).toBe(true)
    expect(index.count()).toBe(2)
    expect(index.search({ q: 'Beta' })).toHaveLength(1)
    expect(index.search({ q: 'Alpha' })).toHaveLength(1)
  })
})
