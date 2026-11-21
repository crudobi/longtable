/**
 * Wave 4D friends/publish-core fixes (2026-11-20 review round).
 *
 * Covers, per finding:
 * - M1-rel: friends-only per-friend isolation (a channel's bytes carry
 *   no other friend's envelope) + the startup republish sweep (a
 *   dropped copy is restored, a stale copy for a de-authorized friend
 *   is stripped, a healthy shelf is left untouched).
 * - M-N1: per-recipe manifest entries — publishing no longer reads +
 *   rewrites one whole manifest, so a corrupt legacy manifest cannot
 *   lose shares and two publishes cannot race each other away.
 * - M-N4: unfriend disconnects first, is per-recipe isolated, persists
 *   a pending-revocation record, and resumes on the next launch.
 * - M-N3: unpublish deletes via the stored publication.pdsUrl first.
 * - M1-sec: payloadHash + DID binding in processChannel — a replayed
 *   or swapped payload, a wrong-owner payload, and a manifest from a
 *   DID other than the channel's friend are all rejected.
 * - M2: single-use invites (used-invite store + expiry) — the best
 *   defensible enforcement, documented in friends.ts: the inviter's
 *   pairing refuses a spent invite; a second guest who already holds
 *   the pairSecret cannot be evicted, which is why S8's per-DID
 *   channels remain the backstop.
 * - M3: the pairing hello's display name is signed (nameSig) and the
 *   guest can pin the name on the invite they scanned.
 * - M4: a bad hello is skipped, never fatal — pairing accepts a later
 *   good hello instead of throwing on the first unverifiable one.
 * - M7: rotate-before-republish is atomic (publish-then-commit, with
 *   rollback) and the shrink path disconnects a friend who holds
 *   nothing anymore.
 * - M8: pair secrets must be strict 32-byte base64 at the invite
 *   boundary; share payloads validate secret shape + snapshot size.
 * - H4: a received friends-only recipe cannot be re-published public
 *   or QR-shared plaintext — provenance is recorded on receipt and
 *   checked at every wide-exposure exit.
 *
 * y-webrtc is mocked with a syncing fake (no network), as in
 * wave1-client.test.ts.
 */
import 'fake-indexeddb/auto'
import * as Y from 'yjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockState = vi.hoisted(() => ({
  Y: null as typeof import('yjs') | null,
  rooms: new Map<string, Set<unknown>>(),
}))
mockState.Y = Y

vi.mock('y-webrtc', () => ({
  WebrtcProvider: class {
    awareness = { getStates: () => new Map() }
    private room: string
    private doc: unknown
    private listener: ((update: Uint8Array) => void) | null = null
    constructor(room: string, doc: unknown) {
      this.room = room
      this.doc = doc
      const Y = mockState.Y
      if (!Y) throw new Error('y-webrtc mock used before Y was set')
      const thisDoc = doc as InstanceType<typeof Y.Doc>
      let peers = mockState.rooms.get(room)
      if (!peers) {
        peers = new Set()
        mockState.rooms.set(room, peers)
      }
      for (const other of peers) {
        const otherDoc = other as InstanceType<typeof Y.Doc>
        Y.applyUpdate(otherDoc, Y.encodeStateAsUpdate(thisDoc))
        Y.applyUpdate(thisDoc, Y.encodeStateAsUpdate(otherDoc))
      }
      peers.add(doc)
      this.listener = (update: Uint8Array) => {
        for (const other of [...(mockState.rooms.get(room) ?? [])]) {
          if (other === doc) continue
          Y.applyUpdate(other as InstanceType<typeof Y.Doc>, update)
        }
      }
      thisDoc.on('update', this.listener)
    }
    destroy() {
      if (this.listener) {
        ;(this.doc as InstanceType<typeof Y.Doc>).off('update', this.listener)
        this.listener = null
      }
      mockState.rooms.get(this.room)?.delete(this.doc)
    }
  },
}))

import { identityFromSeed, signDetached, verifyDetached } from '../identity/identity'
import { u8ToBase64 } from '../identity/codec'
import {
  buildManifest,
  buildManifestEntry,
  encryptRecipePayload,
  ensureRecipeKey,
  getRecipeKey,
  processChannel,
  publishShare,
  readEnvelope,
  readManifestEntry,
  readPayload,
  shelfShareIsCurrent,
  verifyManifestEntry,
  wrapKeyForDid,
} from '../friends/shelf'
import {
  createFriendInvite,
  disconnectAllFriendChannels,
  getChannelDoc,
  hasFriendChannelProvider,
  helloMessage,
  helloNameMessage,
  isInviteUsed,
  listFriends,
  markInviteUsed,
  pairIdFor,
  parseFriendInvite,
  removeFriend,
  runPairing,
  saveFriend,
  validatePairSecret,
  type FriendRecord,
} from '../friends/friends'
import { getRecipeProvenance, isReceivedRecipe } from '../friends/provenance'
import {
  importReceivedShares,
  listReceivedShares,
  loadPendingRevocations,
  resumePendingRevocations,
  rotateAndRepublishRecipe,
  saveReceivedMap,
  shareRecipeWithFriends,
  sweepFriendsOnlyShares,
  unfriendAndRekey,
} from '../friends/service'
import {
  MAX_SNAPSHOT_BYTES,
  destroyAllShareProviders,
  parseSharePayload,
  shareRecipe,
} from '../p2p/share'
import { AtprotoClient, type AtprotoSession } from '../public/atproto'
import {
  getPublication,
  publishRecipe,
  unpublishRecipe,
  type PublishableRecipe,
} from '../public/publish'
import { applyVisibilityFlow } from '../recipeFlows'
import { createRepo, getRepo } from '../store/repo'
import {
  createRecipe,
  getOrCreateIndex,
  getRecipe,
  listRecipes,
  memoryStore,
} from '../store/recipes'
import type { Recipe } from '../types'

const seed = (n: number) => new Uint8Array(32).fill(n)

function mkLocalStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    length: 0,
  } as Storage
}

let dbCounter = 0
const makeRepo = () => createRepo(`longtable-wave4d-${++dbCounter}`)
let pairCounter = 0
const freshPairId = () => (++pairCounter).toString(16).padStart(2, '0') + 'ab'.repeat(31)
/** Valid 32-byte base64 pair secret (32 zero bytes). */
const SECRET_32 = 'A'.repeat(43) + '='

const RECIPE: Recipe = {
  title: 'Secret Soup',
  ingredients: ['1 onion', '2 cloves garlic'],
  steps: ['Chop.', 'Simmer 20 minutes.'],
  prepMinutes: 5,
  cookMinutes: 20,
  photos: [],
  createdAt: '2026-10-12T00:00:00.000Z',
  updatedAt: '2026-10-12T00:00:00.000Z',
  visibility: 'friends-only',
}

function friendRecord(did: string, pairId: string): FriendRecord {
  return {
    did,
    name: `Friend ${did.slice(-4)}`,
    pairSecret: SECRET_32,
    pairId,
    signaling: 'wss://test:4444',
    addedAt: '2026-10-12T00:00:00.000Z',
  }
}

function syncDocs(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b))
}

beforeEach(() => {
  ;(globalThis as { localStorage?: Storage }).localStorage = mkLocalStorage()
  mockState.rooms.clear()
})

afterEach(() => {
  destroyAllShareProviders()
  disconnectAllFriendChannels()
  mockState.rooms.clear()
  delete (globalThis as { localStorage?: Storage }).localStorage
})

describe('M-N1 per-recipe manifest entries', () => {
  it('a corrupt legacy manifest cannot lose shares; each publish writes its own entry', async () => {
    const owner = await identityFromSeed(seed(11))
    const friend = await identityFromSeed(seed(22))
    const kv = memoryStore()
    const doc = new Y.Doc()

    const key1 = await ensureRecipeKey('recipe-0001', kv)
    await publishShare(doc, owner, 'Olga', RECIPE, 'recipe-0001', key1, friend.did)
    const key2 = await ensureRecipeKey('recipe-0002', kv)
    await publishShare(
      doc,
      owner,
      'Olga',
      { ...RECIPE, title: 'Second Soup' },
      'recipe-0002',
      key2,
      friend.did,
    )
    expect(readManifestEntry(doc, owner.did, 'recipe-0001')).not.toBeNull()
    expect(readManifestEntry(doc, owner.did, 'recipe-0002')).not.toBeNull()
    expect(
      await verifyManifestEntry(readManifestEntry(doc, owner.did, 'recipe-0001')!),
    ).toBe(true)

    // Corrupt the whole-manifest key, then publish a third recipe: the
    // publish must succeed (it never reads the legacy manifest) and
    // the first two shares must survive it.
    doc.transact(() => {
      doc.getMap('shelf').set(`manifest:${owner.did}`, '{broken json')
    })
    const key3 = await ensureRecipeKey('recipe-0003', kv)
    await publishShare(
      doc,
      owner,
      'Olga',
      { ...RECIPE, title: 'Third Soup' },
      'recipe-0003',
      key3,
      friend.did,
    )
    expect(readManifestEntry(doc, owner.did, 'recipe-0001')).not.toBeNull()
    expect(readManifestEntry(doc, owner.did, 'recipe-0002')).not.toBeNull()
    expect(readManifestEntry(doc, owner.did, 'recipe-0003')).not.toBeNull()

    const friendDoc = new Y.Doc()
    syncDocs(doc, friendDoc)
    const res = await processChannel(friendDoc, friend)
    expect(res.received.map((r) => r.recipe.title).sort()).toEqual([
      'Second Soup',
      'Secret Soup',
      'Third Soup',
    ])

    // Corrupt the legacy key again: all three shares still import via
    // their per-recipe entries, and the corrupt key is REPORTED, not
    // silently skipped the way allManifests used to skip it.
    friendDoc.transact(() => {
      friendDoc.getMap('shelf').set(`manifest:${owner.did}`, '{broken json')
    })
    const res2 = await processChannel(friendDoc, friend)
    expect(res2.received).toHaveLength(3)
    expect(
      res2.failures.some(
        (f) =>
          f.shareId === `manifest:${owner.did}` && /unparseable/.test(f.reason),
      ),
    ).toBe(true)
  })
})

describe('M1-sec payloadHash + DID binding', () => {
  it('tampered payload bytes fail the manifest hash check', async () => {
    const owner = await identityFromSeed(seed(11))
    const friend = await identityFromSeed(seed(22))
    const kv = memoryStore()
    const ownerDoc = new Y.Doc()
    const keyRec = await ensureRecipeKey('recipe-0001', kv)
    await publishShare(ownerDoc, owner, 'Olga', RECIPE, 'recipe-0001', keyRec, friend.did)

    const friendDoc = new Y.Doc()
    syncDocs(ownerDoc, friendDoc)
    const raw = friendDoc.getMap('shelf').get('payload:recipe-0001') as string
    const payload = JSON.parse(raw) as { ciphertext: string }
    const flipped =
      payload.ciphertext.slice(0, 10) +
      (payload.ciphertext[10] === 'A' ? 'B' : 'A') +
      payload.ciphertext.slice(11)
    friendDoc.transact(() => {
      friendDoc
        .getMap('shelf')
        .set('payload:recipe-0001', JSON.stringify({ ...payload, ciphertext: flipped }))
    })

    const res = await processChannel(friendDoc, friend)
    expect(res.received).toEqual([])
    expect(res.failures).toHaveLength(1)
    expect(res.failures[0].reason).toMatch(/payload bytes do not match the manifest hash/)
  })

  it('a payload naming a different owner DID is rejected', async () => {
    const owner = await identityFromSeed(seed(11))
    const friend = await identityFromSeed(seed(22))
    const attacker = await identityFromSeed(seed(33))
    const kv = memoryStore()
    const ownerDoc = new Y.Doc()
    const keyRec = await ensureRecipeKey('recipe-0001', kv)
    await publishShare(ownerDoc, owner, 'Olga', RECIPE, 'recipe-0001', keyRec, friend.did)

    const friendDoc = new Y.Doc()
    syncDocs(ownerDoc, friendDoc)
    const raw = friendDoc.getMap('shelf').get('payload:recipe-0001') as string
    const payload = JSON.parse(raw) as Record<string, unknown>
    friendDoc.transact(() => {
      friendDoc
        .getMap('shelf')
        .set(
          'payload:recipe-0001',
          JSON.stringify({ ...payload, ownerDid: attacker.did }),
        )
    })

    const res = await processChannel(friendDoc, friend)
    expect(res.received).toEqual([])
    expect(res.failures[0].reason).toMatch(/payload owner does not match/)
  })

  it('a manifest from another DID is rejected when the channel owner is expected', async () => {
    const owner = await identityFromSeed(seed(11))
    const friend = await identityFromSeed(seed(22))
    const attacker = await identityFromSeed(seed(33))
    const kvOwner = memoryStore()
    const kvAtk = memoryStore()

    const friendDoc = new Y.Doc()
    const ownerDoc = new Y.Doc()
    const keyRec = await ensureRecipeKey('recipe-0001', kvOwner)
    await publishShare(ownerDoc, owner, 'Olga', RECIPE, 'recipe-0001', keyRec, friend.did)
    Y.applyUpdate(friendDoc, Y.encodeStateAsUpdate(ownerDoc))

    // The attacker publishes their own share into the same shelf doc.
    const atkDoc = new Y.Doc()
    const atkKey = await ensureRecipeKey('recipe-atk', kvAtk)
    await publishShare(
      atkDoc,
      attacker,
      'Mallory',
      { ...RECIPE, title: 'Evil Soup' },
      'recipe-atk',
      atkKey,
      friend.did,
    )
    Y.applyUpdate(friendDoc, Y.encodeStateAsUpdate(atkDoc))

    const res = await processChannel(friendDoc, friend, owner.did)
    expect(res.received).toHaveLength(1)
    expect(res.received[0].recipe.title).toBe('Secret Soup')
    expect(
      res.failures.some((f) => /not from the expected friend/.test(f.reason)),
    ).toBe(true)
  })

  it('a legacy payload without a hash still imports (compat)', async () => {
    const owner = await identityFromSeed(seed(11))
    const friend = await identityFromSeed(seed(22))
    const kv = memoryStore()
    const keyRec = await ensureRecipeKey('recipe-old', kv)
    const ciphertext = await encryptRecipePayload(keyRec.key, RECIPE)
    const sealedKey = await wrapKeyForDid(keyRec.key, friend.did)
    const doc = new Y.Doc()
    doc.transact(() => {
      const map = doc.getMap('shelf')
      map.set(
        'payload:recipe-old',
        JSON.stringify({
          shareId: 'recipe-old',
          recipeId: 'recipe-old',
          ownerDid: owner.did,
          keyId: keyRec.keyId,
          updatedAt: RECIPE.updatedAt,
          ciphertext,
        }),
      )
      map.set(
        `envelope:recipe-old:${friend.did}`,
        JSON.stringify({
          shareId: 'recipe-old',
          recipeId: 'recipe-old',
          to: friend.did,
          keyId: keyRec.keyId,
          sealedKey,
        }),
      )
    })
    const manifest = await buildManifest(owner, 'Olga', [
      {
        shareId: 'recipe-old',
        recipeId: 'recipe-old',
        keyId: keyRec.keyId,
        updatedAt: RECIPE.updatedAt,
      },
    ])
    doc.transact(() => {
      doc.getMap('shelf').set(`manifest:${owner.did}`, JSON.stringify(manifest))
    })
    const entry = await buildManifestEntry(owner, 'Olga', {
      shareId: 'recipe-old',
      recipeId: 'recipe-old',
      keyId: keyRec.keyId,
      updatedAt: RECIPE.updatedAt,
    })
    doc.transact(() => {
      doc
        .getMap('shelf')
        .set(`manifest-entry:${owner.did}:recipe-old`, JSON.stringify(entry))
    })

    const res = await processChannel(doc, friend)
    expect(res.failures).toEqual([])
    expect(res.received).toHaveLength(1)
    expect(res.received[0].recipe.title).toBe('Secret Soup')
  })
})

describe('M1-rel per-friend isolation + startup sweep', () => {
  async function sharedSetup() {
    const owner = await identityFromSeed(seed(11))
    const a = await identityFromSeed(seed(22))
    const b = await identityFromSeed(seed(33))
    const kv = memoryStore()
    const repo = makeRepo()
    const recA = friendRecord(a.did, freshPairId())
    const recB = friendRecord(b.did, freshPairId())
    saveFriend(recA, kv)
    saveFriend(recB, kv)
    const index = await getOrCreateIndex(repo)
    const summary = await createRecipe(repo, index, {
      title: 'Secret Soup',
      ingredients: ['1 onion'],
      steps: ['Chop.'],
      photos: [],
      visibility: 'friends-only',
    })
    await shareRecipeWithFriends(summary.id, [a.did, b.did], owner, kv, repo)
    return { owner, a, b, kv, repo, recA, recB, id: summary.id }
  }

  it("one friend's channel bytes carry no envelope for the other friend", async () => {
    const { b, repo, recA, id } = await sharedSetup()
    const docA = await getChannelDoc(recA, repo)
    expect(readEnvelope(docA, id, b.did)).toBeNull()
    expect(readPayload(docA, id)).not.toBeNull()

    // B holding A's exact channel bytes decrypts nothing.
    const bCopy = new Y.Doc()
    Y.applyUpdate(bCopy, Y.encodeStateAsUpdate(docA))
    const res = await processChannel(bCopy, b)
    expect(res.received).toEqual([])
    expect(res.failures.some((f) => /no key envelope/.test(f.reason))).toBe(true)
  })

  it('sweep restores a dropped copy, strips a stale copy, and leaves healthy shelves alone', async () => {
    const { owner, a, b, kv, repo, recA, recB, id } = await sharedSetup()
    const docB = await getChannelDoc(recB, repo)
    expect(shelfShareIsCurrent(docB, owner.did, id, getRecipeKey(id, kv)!.keyId, b.did)).toBe(true)

    // Drop B's payload (a missed publish): the sweep restores it.
    docB.transact(() => {
      docB.getMap('shelf').delete(`payload:${id}`)
    })
    expect(shelfShareIsCurrent(docB, owner.did, id, getRecipeKey(id, kv)!.keyId, b.did)).toBe(false)
    const first = await sweepFriendsOnlyShares(owner, kv, repo)
    expect(first.republished).toBe(1)
    expect(first.removed).toBe(0)
    expect(first.failures).toEqual([])
    expect(shelfShareIsCurrent(docB, owner.did, id, getRecipeKey(id, kv)!.keyId, b.did)).toBe(true)

    // A healthy shelf is untouched on the next sweep.
    const second = await sweepFriendsOnlyShares(owner, kv, repo)
    expect(second.republished).toBe(0)
    expect(second.removed).toBe(0)

    // A stale copy for a de-authorized friend is stripped by the sweep.
    const c = await identityFromSeed(seed(44))
    const recC = friendRecord(c.did, freshPairId())
    saveFriend(recC, kv)
    await shareRecipeWithFriends(id, [a.did, b.did, c.did], owner, kv, repo)
    await shareRecipeWithFriends(id, [a.did, b.did], owner, kv, repo)
    const docC = await getChannelDoc(recC, repo)
    expect(readPayload(docC, id)).toBeNull()
    // Simulate the missed unpublish: a stale copy lands in C's doc.
    const entry = (await (await getOrCreateIndex(repo)).doc())?.recipes[id]
    const recipe = await getRecipe(repo, entry!.url)
    await publishShare(docC, owner, '', recipe!, id, getRecipeKey(id, kv)!, c.did)
    expect(readPayload(docC, id)).not.toBeNull()
    const third = await sweepFriendsOnlyShares(owner, kv, repo)
    expect(third.removed).toBe(1)
    expect(readPayload(docC, id)).toBeNull()
    void recA
  })
})

describe('M-N4 unfriend atomic + resumable', () => {
  async function sharedSetup() {
    const owner = await identityFromSeed(seed(11))
    const a = await identityFromSeed(seed(22))
    const b = await identityFromSeed(seed(33))
    const kv = memoryStore()
    const repo = makeRepo()
    const recA = friendRecord(a.did, freshPairId())
    const recB = friendRecord(b.did, freshPairId())
    saveFriend(recA, kv)
    saveFriend(recB, kv)
    const index = await getOrCreateIndex(repo)
    const summary = await createRecipe(repo, index, {
      title: 'Secret Soup',
      ingredients: ['1 onion'],
      steps: ['Chop.'],
      photos: [],
      visibility: 'friends-only',
    })
    await shareRecipeWithFriends(summary.id, [a.did, b.did], owner, kv, repo)
    return { owner, a, b, kv, repo, recA, recB, id: summary.id }
  }

  it('unfriend disconnects first, rotates, and leaves no pending record', async () => {
    const { owner, a, b, kv, repo, recA, recB, id } = await sharedSetup()
    const oldKeyId = getRecipeKey(id, kv)!.keyId
    expect(hasFriendChannelProvider(a.did)).toBe(true)

    await unfriendAndRekey(a.did, owner, kv, repo)

    expect(listFriends(kv).map((f) => f.did)).toEqual([b.did])
    expect(loadPendingRevocations(kv)).toEqual([])
    expect(hasFriendChannelProvider(a.did)).toBe(false)
    const newKeyId = getRecipeKey(id, kv)!.keyId
    expect(newKeyId).not.toBe(oldKeyId)
    expect(getRecipeKey(id, kv)!.friends).toEqual([b.did])
    const docA = await getChannelDoc(recA, repo)
    expect(readPayload(docA, id)).toBeNull()
    const docB = await getChannelDoc(recB, repo)
    expect(readPayload(docB, id)!.keyId).toBe(newKeyId)
    const bCopy = new Y.Doc()
    Y.applyUpdate(bCopy, Y.encodeStateAsUpdate(docB))
    const res = await processChannel(bCopy, b)
    expect(res.received).toHaveLength(1)
  })

  it('a failed unfriend leaves a pending record; the resume finishes it', async () => {
    const { owner, a, b, kv, repo, recA, recB, id } = await sharedSetup()
    const oldKeyId = getRecipeKey(id, kv)!.keyId

    // Sabotage the rotate: B's friend record is gone, so the republish
    // to the remaining friend cannot happen.
    removeFriend(b.did, kv)
    await expect(unfriendAndRekey(a.did, owner, kv, repo)).rejects.toThrow(
      /still need re-keying/,
    )

    // Disconnect-first held even on failure, and the pending record
    // survives with the unfinished recipe.
    expect(hasFriendChannelProvider(a.did)).toBe(false)
    expect(listFriends(kv)).toEqual([])
    const pending = loadPendingRevocations(kv)
    expect(pending).toHaveLength(1)
    expect(pending[0].friendDid).toBe(a.did)
    expect(pending[0].recipeIds).toEqual([id])
    expect(pending[0].failures[id]).toBeTruthy()
    // The key was never committed (rotate is atomic) and A's payload
    // was still stripped before the failure.
    expect(getRecipeKey(id, kv)!.keyId).toBe(oldKeyId)
    const docA = await getChannelDoc(recA, repo)
    expect(readPayload(docA, id)).toBeNull()

    // Restore B and resume: the revocation finishes, the key rotates.
    saveFriend(recB, kv)
    const resumed = await resumePendingRevocations(owner, kv, repo)
    expect(resumed.finished).toBe(1)
    expect(resumed.stillPending).toBe(0)
    expect(loadPendingRevocations(kv)).toEqual([])
    expect(getRecipeKey(id, kv)!.keyId).not.toBe(oldKeyId)
    const docB = await getChannelDoc(recB, repo)
    const bCopy = new Y.Doc()
    Y.applyUpdate(bCopy, Y.encodeStateAsUpdate(docB))
    expect((await processChannel(bCopy, b)).received).toHaveLength(1)
  })
})

describe('M-N3 unpublish via the stored publication.pdsUrl', () => {
  const OLD_PDS = 'https://old-pds.test'
  const NEW_PDS = 'https://new-pds.test'
  const ACCT = 'did:plc:accttest'
  const SEED = new Uint8Array(32).fill(9)

  interface HostState {
    records: Map<string, { record: Record<string, unknown>; cid: string }>
    calls: Array<{ path: string; body: Record<string, unknown> }>
    failDelete: boolean
  }

  function makeTwoHostPds() {
    const hosts = new Map<string, HostState>()
    let n = 0
    const hostFor = (origin: string): HostState => {
      let h = hosts.get(origin)
      if (!h) {
        h = { records: new Map(), calls: [], failDelete: false }
        hosts.set(origin, h)
      }
      return h
    }
    const json = (obj: unknown, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    const key = (repo: string, collection: string, rkey: string) =>
      `${repo}/${collection}/${rkey}`
    const fetchFn = async (url: string, init: RequestInit = {}): Promise<Response> => {
      const u = new URL(url)
      const host = hostFor(u.origin)
      const path = u.pathname.replace(/^\/xrpc\//, '')
      const body =
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {}
      switch (path) {
        case 'com.atproto.server.createSession':
          return json({
            did: ACCT,
            handle: 'alice.test',
            accessJwt: 'access-1',
            refreshJwt: 'refresh-1',
          })
        case 'com.atproto.server.refreshSession':
          return json({
            did: ACCT,
            handle: 'alice.test',
            accessJwt: 'access-2',
            refreshJwt: 'refresh-2',
          })
        case 'com.atproto.repo.putRecord': {
          host.calls.push({ path, body })
          const cid = `bafyrec${++n}`
          host.records.set(
            key(body.repo as string, body.collection as string, body.rkey as string),
            { record: body.record as Record<string, unknown>, cid },
          )
          return json({
            uri: `at://${body.repo as string}/${body.collection as string}/${body.rkey as string}`,
            cid,
          })
        }
        case 'com.atproto.repo.getRecord': {
          const hit = host.records.get(
            key(
              u.searchParams.get('repo')!,
              u.searchParams.get('collection')!,
              u.searchParams.get('rkey')!,
            ),
          )
          if (!hit) return json({ error: 'RecordNotFound', message: 'Record not found' }, 400)
          return json({
            uri: `at://${u.searchParams.get('repo')}/${u.searchParams.get('collection')}/${u.searchParams.get('rkey')}`,
            cid: hit.cid,
            value: hit.record,
          })
        }
        case 'com.atproto.repo.deleteRecord': {
          host.calls.push({ path, body })
          const k = key(body.repo as string, body.collection as string, body.rkey as string)
          if (host.failDelete) return json({ error: 'Internal', message: 'boom' }, 500)
          if (!host.records.has(k)) {
            return json({ error: 'RecordNotFound', message: 'Record not found' }, 404)
          }
          host.records.delete(k)
          return json({})
        }
        case 'com.atproto.repo.uploadBlob':
          return json({
            blob: { $type: 'blob', ref: { $link: 'bafyblob1' }, mimeType: 'image/png', size: 0 },
          })
        default:
          return json({ error: 'Unknown', message: `no fake endpoint: ${path}` }, 404)
      }
    }
    return { fetchFn, hosts, hostFor }
  }

  function fixtureRecipe(): PublishableRecipe {
    return {
      id: 'recipe-1',
      title: 'Tomato Soup',
      ingredients: ['tomatoes'],
      steps: ['Simmer'],
      photos: [],
      prepMinutes: 5,
      cookMinutes: 25,
      createdAt: '2026-01-01T10:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    }
  }

  async function publishOnOld() {
    const fake = makeTwoHostPds()
    const client = new AtprotoClient(OLD_PDS, { fetchFn: fake.fetchFn })
    const session = await client.createSession('alice.test', 'app-password-1')
    const identity = await identityFromSeed(SEED)
    const kv = memoryStore()
    await publishRecipe(client, session, identity, fixtureRecipe(), kv)
    expect(getPublication('recipe-1', kv)!.pdsUrl).toBe(OLD_PDS)
    return { fake, client, session, identity, kv }
  }

  it('deletes from the stored PDS first, even after the session moved', async () => {
    const { fake, session, kv } = await publishOnOld()
    const oldHost = fake.hostFor(OLD_PDS)
    const newHost = fake.hostFor(NEW_PDS)
    expect(oldHost.records.size).toBe(2) // pubkey binding + recipe

    // Account moved: the session now points at the new PDS.
    session.pdsUrl = NEW_PDS
    const newClient = new AtprotoClient(NEW_PDS, { fetchFn: fake.fetchFn })
    const result = await unpublishRecipe(newClient, session, 'recipe-1', kv, {
      fetchFn: fake.fetchFn,
    })

    expect(result.pdsUrlsAttempted[0]).toBe(OLD_PDS)
    expect(result.warnings.some((w) => /different publishing server/.test(w))).toBe(true)
    expect(
      oldHost.calls.some(
        (c) => c.path === 'com.atproto.repo.deleteRecord' && c.body.rkey === 'recipe-1',
      ),
    ).toBe(true)
    expect(
      [...oldHost.records.keys()].some((k) => k.endsWith('/kitchen.longtable.recipe/recipe-1')),
    ).toBe(false)
    expect(newHost.records.size).toBe(0)
    expect(getPublication('recipe-1', kv)).toBeNull()
  })

  it('a 404 on the stored PDS still drops the registry', async () => {
    const { fake, session, kv } = await publishOnOld()
    fake.hostFor(OLD_PDS).records.clear() // record already gone from the old PDS
    session.pdsUrl = NEW_PDS
    const newClient = new AtprotoClient(NEW_PDS, { fetchFn: fake.fetchFn })
    const result = await unpublishRecipe(newClient, session, 'recipe-1', kv, {
      fetchFn: fake.fetchFn,
    })
    expect(result.warnings.some((w) => /already gone/.test(w))).toBe(true)
    expect(getPublication('recipe-1', kv)).toBeNull()
  })

  it('a failed delete keeps the registry so the removal can be retried', async () => {
    const { fake, session, kv } = await publishOnOld()
    fake.hostFor(OLD_PDS).failDelete = true
    session.pdsUrl = NEW_PDS
    const newClient = new AtprotoClient(NEW_PDS, { fetchFn: fake.fetchFn })
    await expect(
      unpublishRecipe(newClient, session, 'recipe-1', kv, { fetchFn: fake.fetchFn }),
    ).rejects.toThrow(/may still be live|did not answer/)
    expect(getPublication('recipe-1', kv)).not.toBeNull()
  })
})

describe('M2 single-use invites', () => {
  // A peer that answers a pairing with a valid signed hello, driven
  // directly (no second runPairing). The two-sided Promise.all pairing
  // is covered by the S8 test in wave1-client.test.ts; doing it here
  // too flakes on a vitest mock race — two CONCURRENT dynamic imports
  // of 'y-webrtc' can resolve one side to the REAL module (proven
  // 2026-11-21: provider keys _observers/signalingConns on one side,
  // the mock's awareness/room/doc/listener on the other), so that side
  // never syncs and the pairing times out. Sequential manual peers
  // have no concurrent import and never hit it. Wave 4E owns the S8
  // flake root cause.
  async function manualPeer(
    invite: Awaited<ReturnType<typeof createFriendInvite>>,
    peer: Awaited<ReturnType<typeof identityFromSeed>>,
    peerName: string,
  ): Promise<{ provider: { destroy(): void }; peerDoc: Y.Doc }> {
    const pairId = await pairIdFor(invite.pairSecret)
    const { WebrtcProvider } = await import('y-webrtc')
    const peerDoc = new Y.Doc()
    const provider = new WebrtcProvider(invite.room, peerDoc)
    const sig = await signDetached(peer, helloMessage(invite.room, peer.did, pairId))
    const nameSig = await signDetached(
      peer,
      helloNameMessage(invite.room, peer.did, pairId, peerName),
    )
    peerDoc.transact(() => {
      peerDoc.getMap('pairing').set(
        peer.did,
        JSON.stringify({
          did: peer.did,
          name: peerName,
          sig: u8ToBase64(sig),
          nameSig: u8ToBase64(nameSig),
          channelVersion: 2,
        }),
      )
    })
    return { provider, peerDoc }
  }

  it('a second pairing on the same invite is refused on both sides', async () => {
    const alice = await identityFromSeed(seed(71))
    const bob = await identityFromSeed(seed(72))
    const invite = await createFriendInvite(alice, 'Alice', 'wss://test:4444')
    const kvA = memoryStore()
    const kvB = memoryStore()
    const pairId = await pairIdFor(invite.pairSecret)

    // Inviter side: Bob answers manually, Alice pairs, the invite is
    // marked used on her store — and a second pairing is refused.
    const bobPeer = await manualPeer(invite, bob, 'Bob')
    try {
      const recA = await runPairing(alice, 'Alice', invite, null, kvA, 10000, {
        singleUse: true,
      })
      expect(recA.did).toBe(bob.did)
    } finally {
      bobPeer.provider.destroy()
      bobPeer.peerDoc.destroy()
    }
    expect(isInviteUsed(pairId, invite.room, kvA)).toBe(true)
    await expect(
      runPairing(alice, 'Alice', invite, null, kvA, 5000, { singleUse: true }),
    ).rejects.toThrow(/already been used/)

    // Guest side: Alice answers manually, Bob pairs, the invite is
    // marked used on his store — and a second pairing is refused.
    const alicePeer = await manualPeer(invite, alice, 'Alice')
    try {
      const recB = await runPairing(bob, 'Bob', invite, alice.did, kvB, 10000, {
        singleUse: true,
      })
      expect(recB.did).toBe(alice.did)
    } finally {
      alicePeer.provider.destroy()
      alicePeer.peerDoc.destroy()
    }
    expect(isInviteUsed(pairId, invite.room, kvB)).toBe(true)
    await expect(
      runPairing(bob, 'Bob', invite, alice.did, kvB, 5000, { singleUse: true }),
    ).rejects.toThrow(/already been used/)
  }, 20000)

  it('an invite already marked used is refused immediately, without waiting for a peer', async () => {
    // Deterministic form of the same enforcement: no peer, no timing
    // surface — the used-invite store alone refuses the pairing.
    const alice = await identityFromSeed(seed(71))
    const bob = await identityFromSeed(seed(72))
    const invite = await createFriendInvite(alice, 'Alice', 'wss://test:4444')
    const kvA = memoryStore()
    const pairId = await pairIdFor(invite.pairSecret)
    expect(isInviteUsed(pairId, invite.room, kvA)).toBe(false)
    markInviteUsed(pairId, invite.room, bob.did, kvA)
    expect(isInviteUsed(pairId, invite.room, kvA)).toBe(true)
    await expect(
      runPairing(alice, 'Alice', invite, null, kvA, 5000, { singleUse: true }),
    ).rejects.toThrow(/already been used/)
    // The store does not block a non-single-use pairing: the flag is
    // the gate, and the S8 separate-channels path stays available
    // without it.
    expect(isInviteUsed(pairId, invite.room, memoryStore())).toBe(false)
  })

  it('expired invites and short pair secrets are rejected at parse', async () => {
    const alice = await identityFromSeed(seed(71))
    const invite = await createFriendInvite(alice, 'Alice', 'wss://test:4444')
    expect(invite.expiresAt).toBeTruthy()
    expect(() => parseFriendInvite(JSON.stringify(invite))).not.toThrow()

    const expired = {
      ...invite,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }
    expect(() => parseFriendInvite(JSON.stringify(expired))).toThrow(/expired/)

    expect(() =>
      parseFriendInvite(JSON.stringify({ ...invite, pairSecret: 'AAAA' })),
    ).toThrow(/not a valid Longtable friend invitation/)
    expect(() =>
      parseFriendInvite(JSON.stringify({ ...invite, pairSecret: '!!!not-base64' })),
    ).toThrow(/not a valid Longtable friend invitation/)

    expect(() => validatePairSecret('AAAA')).toThrow()
    expect(() => validatePairSecret(SECRET_32)).not.toThrow()
    expect(() => validatePairSecret('c2VjcmV0')).toThrow(/wrong length/)
    markInviteUsed('ab'.repeat(32), 'longtable-pair-abcdef', alice.did, memoryStore())
  })
})

describe('M3 invite display name bound to DID', () => {
  it('helloNameMessage verifies only for the signed name', async () => {
    const me = await identityFromSeed(seed(9))
    const pairId = await pairIdFor(SECRET_32)
    const room = 'longtable-pair-0123456789abcdef'
    const sig = await signDetached(me, helloNameMessage(room, me.did, pairId, 'Olga'))
    expect(
      await verifyDetached(me.did, helloNameMessage(room, me.did, pairId, 'Olga'), sig),
    ).toBe(true)
    expect(
      await verifyDetached(me.did, helloNameMessage(room, me.did, pairId, 'Mallory'), sig),
    ).toBe(false)
  })

  it('a v2 hello without a valid name signature is skipped (pairing times out)', async () => {
    const alice = await identityFromSeed(seed(71))
    const bob = await identityFromSeed(seed(72))
    const invite = await createFriendInvite(alice, 'Alice', 'wss://test:4444')
    const pairId = await pairIdFor(invite.pairSecret)
    const kvA = memoryStore()

    // A peer that announces a v2 hello but never signed its name.
    const { WebrtcProvider } = await import('y-webrtc')
    const peerDoc = new Y.Doc()
    const provider = new WebrtcProvider(invite.room, peerDoc)
    try {
      const sig = await signDetached(bob, helloMessage(invite.room, bob.did, pairId))
      peerDoc.transact(() => {
        peerDoc.getMap('pairing').set(
          bob.did,
          JSON.stringify({
            did: bob.did,
            name: 'Bob',
            sig: u8ToBase64(sig),
            channelVersion: 2,
          }),
        )
      })
      await expect(
        runPairing(alice, 'Alice', invite, null, kvA, 1500),
      ).rejects.toThrow(/timed out.*1 unverifiable hello/)
    } finally {
      provider.destroy()
      peerDoc.destroy()
    }
  }, 10000)

  it('a v2 hello WITH a valid name signature pairs normally', async () => {
    const alice = await identityFromSeed(seed(71))
    const bob = await identityFromSeed(seed(72))
    const invite = await createFriendInvite(alice, 'Alice', 'wss://test:4444')
    const pairId = await pairIdFor(invite.pairSecret)
    const kvA = memoryStore()

    const { WebrtcProvider } = await import('y-webrtc')
    const peerDoc = new Y.Doc()
    const provider = new WebrtcProvider(invite.room, peerDoc)
    try {
      const sig = await signDetached(bob, helloMessage(invite.room, bob.did, pairId))
      const nameSig = await signDetached(
        bob,
        helloNameMessage(invite.room, bob.did, pairId, 'Bob'),
      )
      peerDoc.transact(() => {
        peerDoc.getMap('pairing').set(
          bob.did,
          JSON.stringify({
            did: bob.did,
            name: 'Bob',
            sig: u8ToBase64(sig),
            nameSig: u8ToBase64(nameSig),
            channelVersion: 2,
          }),
        )
      })
      const rec = await runPairing(alice, 'Alice', invite, null, kvA, 10000)
      expect(rec.did).toBe(bob.did)
      expect(rec.name).toBe('Bob')
      expect(rec.channelTag).toBeDefined()
    } finally {
      provider.destroy()
      peerDoc.destroy()
    }
  }, 20000)

  it('a guest rejects a hello whose name differs from the invite', async () => {
    const alice = await identityFromSeed(seed(71))
    const bob = await identityFromSeed(seed(72))
    const invite = await createFriendInvite(alice, 'Alice', 'wss://test:4444')
    const pairId = await pairIdFor(invite.pairSecret)
    const kvB = memoryStore()

    // The inviter answers, but under a different name than the invite
    // the guest scanned — with a signature valid for THAT name.
    const { WebrtcProvider } = await import('y-webrtc')
    const peerDoc = new Y.Doc()
    const provider = new WebrtcProvider(invite.room, peerDoc)
    try {
      const sig = await signDetached(alice, helloMessage(invite.room, alice.did, pairId))
      const nameSig = await signDetached(
        alice,
        helloNameMessage(invite.room, alice.did, pairId, 'Alicia'),
      )
      peerDoc.transact(() => {
        peerDoc.getMap('pairing').set(
          alice.did,
          JSON.stringify({
            did: alice.did,
            name: 'Alicia',
            sig: u8ToBase64(sig),
            nameSig: u8ToBase64(nameSig),
            channelVersion: 2,
          }),
        )
      })
      await expect(
        runPairing(bob, 'Bob', invite, alice.did, kvB, 1500, {
          expectedPeerName: invite.name,
        }),
      ).rejects.toThrow(/timed out/)
    } finally {
      provider.destroy()
      peerDoc.destroy()
    }
  }, 10000)
})

describe('M4 pairing hello skip-on-bad', () => {
  it('a bad hello is skipped and a later good hello is accepted', async () => {
    const alice = await identityFromSeed(seed(71))
    const bob = await identityFromSeed(seed(72))
    const racer = await identityFromSeed(seed(73))
    const invite = await createFriendInvite(alice, 'Alice', 'wss://test:4444')
    const pairId = await pairIdFor(invite.pairSecret)
    const kvA = memoryStore()

    const { WebrtcProvider } = await import('y-webrtc')
    const peerDoc = new Y.Doc()
    const provider = new WebrtcProvider(invite.room, peerDoc)
    try {
      // A racer's hello with a garbage signature, written first…
      peerDoc.transact(() => {
        peerDoc.getMap('pairing').set(
          racer.did,
          JSON.stringify({
            did: racer.did,
            name: 'Racer',
            sig: 'AAAA',
            channelVersion: 2,
          }),
        )
      })
      // …then the genuine guest's hello.
      const sig = await signDetached(bob, helloMessage(invite.room, bob.did, pairId))
      const nameSig = await signDetached(
        bob,
        helloNameMessage(invite.room, bob.did, pairId, 'Bob'),
      )
      peerDoc.transact(() => {
        peerDoc.getMap('pairing').set(
          bob.did,
          JSON.stringify({
            did: bob.did,
            name: 'Bob',
            sig: u8ToBase64(sig),
            nameSig: u8ToBase64(nameSig),
            channelVersion: 2,
          }),
        )
      })
      const rec = await runPairing(alice, 'Alice', invite, null, kvA, 10000)
      expect(rec.did).toBe(bob.did)
      expect(rec.name).toBe('Bob')
    } finally {
      provider.destroy()
      peerDoc.destroy()
    }
  }, 20000)
})

describe('M7 rotate atomicity', () => {
  it('a failed rotate leaves the vault on the old key and rolls friends back', async () => {
    const owner = await identityFromSeed(seed(11))
    const a = await identityFromSeed(seed(22))
    const b = await identityFromSeed(seed(33))
    const kv = memoryStore()
    const repo = makeRepo()
    const recA = friendRecord(a.did, freshPairId())
    const recB = friendRecord(b.did, freshPairId())
    saveFriend(recA, kv)
    saveFriend(recB, kv)
    const index = await getOrCreateIndex(repo)
    const summary = await createRecipe(repo, index, {
      title: 'Secret Soup',
      ingredients: ['1 onion'],
      steps: ['Chop.'],
      photos: [],
      visibility: 'friends-only',
    })
    await shareRecipeWithFriends(summary.id, [a.did, b.did], owner, kv, repo)
    const entry = (await index.doc())?.recipes[summary.id]
    const recipe = await getRecipe(repo, entry!.url)
    const oldKeyId = getRecipeKey(summary.id, kv)!.keyId

    // B's record is gone: the rotate cannot reach them.
    removeFriend(b.did, kv)
    await expect(
      rotateAndRepublishRecipe(summary.id, [a.did, b.did], recipe!, owner, kv, repo),
    ).rejects.toThrow(/Could not re-key/)
    expect(getRecipeKey(summary.id, kv)!.keyId).toBe(oldKeyId)
    const docA = await getChannelDoc(recA, repo)
    expect(readPayload(docA, summary.id)!.keyId).toBe(oldKeyId)

    // With B back, the same rotate succeeds and both friends move.
    saveFriend(recB, kv)
    const rec = await rotateAndRepublishRecipe(
      summary.id,
      [a.did, b.did],
      recipe!,
      owner,
      kv,
      repo,
    )
    expect(rec.keyId).not.toBe(oldKeyId)
    expect(getRecipeKey(summary.id, kv)!.keyId).toBe(rec.keyId)
    expect(readPayload(docA, summary.id)!.keyId).toBe(rec.keyId)
    const docB = await getChannelDoc(recB, repo)
    expect(readPayload(docB, summary.id)!.keyId).toBe(rec.keyId)
  })

  it('shrink disconnects a friend with nothing left, keeps one with other recipes', async () => {
    const owner = await identityFromSeed(seed(11))
    const a = await identityFromSeed(seed(22))
    const b = await identityFromSeed(seed(33))
    const kv = memoryStore()
    const repo = makeRepo()
    const recA = friendRecord(a.did, freshPairId())
    const recB = friendRecord(b.did, freshPairId())
    saveFriend(recA, kv)
    saveFriend(recB, kv)
    const index = await getOrCreateIndex(repo)
    const r1 = await createRecipe(repo, index, {
      title: 'Soup One',
      ingredients: [],
      steps: [],
      photos: [],
      visibility: 'friends-only',
    })
    const r2 = await createRecipe(repo, index, {
      title: 'Soup Two',
      ingredients: [],
      steps: [],
      photos: [],
      visibility: 'friends-only',
    })
    await shareRecipeWithFriends(r1.id, [a.did, b.did], owner, kv, repo)
    await shareRecipeWithFriends(r2.id, [a.did], owner, kv, repo)
    expect(hasFriendChannelProvider(a.did)).toBe(true)
    expect(hasFriendChannelProvider(b.did)).toBe(true)

    await shareRecipeWithFriends(r1.id, [a.did], owner, kv, repo)
    expect(hasFriendChannelProvider(b.did)).toBe(false)
    expect(hasFriendChannelProvider(a.did)).toBe(true)
    const docB = await getChannelDoc(recB, repo)
    expect(readPayload(docB, r1.id)).toBeNull()
  })
})

describe('M8 secret-length validation', () => {
  it('share payloads reject a malformed secret and an oversized snapshot', () => {
    const id = 'wave4d-share-1'
    const base = {
      v: 1,
      room: `longtable-share-${id}`,
      signaling: 'wss://test:4444',
      recipeId: id,
      title: 'X',
    }
    expect(() =>
      parseSharePayload(JSON.stringify({ ...base, secret: '!!!not-base64' })),
    ).toThrow(/not a valid Longtable share/)
    expect(() =>
      parseSharePayload(
        JSON.stringify({ ...base, snapshot: 'A'.repeat(45_000_000), secret: SECRET_32 }),
      ),
    ).toThrow(/not a valid Longtable share/)
    expect(MAX_SNAPSHOT_BYTES).toBe(32 * 1024 * 1024)
    // A well-formed short test secret still parses (format-only rule
    // for share payloads — see share.ts); the 32-byte rule lives at
    // the friend-invite boundary.
    expect(
      parseSharePayload(JSON.stringify({ ...base, secret: 'c2VjcmV0' })).secret,
    ).toBe('c2VjcmV0')
  })
})

describe('H4 re-share provenance', () => {
  it('a received friends-only recipe cannot go public or QR-shared', async () => {
    const owner = await identityFromSeed(seed(11))
    const receiver = await identityFromSeed(seed(55))
    const kvOwner = memoryStore()
    const kvRecv = memoryStore()
    const repoRecv = makeRepo()
    const recOwner = friendRecord(owner.did, freshPairId())
    saveFriend(recOwner, kvRecv)

    const ownerDoc = new Y.Doc()
    const keyRec = await ensureRecipeKey('recipe-shared-1', kvOwner)
    await publishShare(ownerDoc, owner, 'Olga', RECIPE, 'recipe-shared-1', keyRec, receiver.did)
    const channelDoc = await getChannelDoc(recOwner, repoRecv)
    Y.applyUpdate(channelDoc, Y.encodeStateAsUpdate(ownerDoc))

    const count = await importReceivedShares(receiver, kvRecv, repoRecv)
    expect(count).toBe(1)
    const listed = await listReceivedShares(kvRecv, repoRecv)
    expect(listed).toHaveLength(1)
    const localId = listed[0].localId
    expect(isReceivedRecipe(localId, kvRecv)).toBe(true)
    expect(getRecipeProvenance(localId, kvRecv)?.ownerDid).toBe(owner.did)

    const index = await getOrCreateIndex(repoRecv)
    const summaries = await listRecipes(index)
    const loaded = await getRecipe(repoRecv, summaries.find((s) => s.id === localId)!.url)
    expect(loaded).not.toBeNull()

    // Public publish is refused before any network step.
    const dummyClient = new AtprotoClient('https://example.test')
    const dummySession: AtprotoSession = {
      did: 'did:plc:dummy',
      handle: '',
      pdsUrl: 'https://example.test',
      accessJwt: 'x',
      refreshJwt: 'y',
    }
    await expect(
      publishRecipe(dummyClient, dummySession, receiver, { ...loaded!, id: localId }, kvRecv),
    ).rejects.toThrow(/not yours to publish/)

    // QR sharing is refused too.
    await expect(
      shareRecipe(localId, 'Secret Soup', 'wss://test:4444', kvRecv),
    ).rejects.toThrow(/not yours to publish/)

    // The visibility flow refuses as well (UI and localhost API share it).
    await expect(
      applyVisibilityFlow(localId, loaded!, 'public', { identity: receiver, kv: kvRecv }),
    ).rejects.toThrow(/not yours to publish/)

    // But an owned recipe shares fine.
    const ownIndex = await getOrCreateIndex(getRepo())
    const own = await createRecipe(getRepo(), ownIndex, {
      title: 'My Own Soup',
      ingredients: [],
      steps: [],
      photos: [],
    })
    const payload = await shareRecipe(own.id, 'My Own Soup', 'wss://test:4444', kvRecv)
    expect(payload.recipeId).toBe(own.id)
  })

  it('provenance is backfilled from a legacy received-shares mapping', async () => {
    const owner = await identityFromSeed(seed(11))
    const kv = memoryStore()
    const localId = 'local-copy-1'
    expect(isReceivedRecipe(localId, kv)).toBe(false)
    saveReceivedMap(kv, {
      [`${owner.did}:recipe-orig-1`]: { localId, updatedAt: '2026-10-12T00:00:00.000Z' },
    })
    expect(isReceivedRecipe(localId, kv)).toBe(true)
    expect(getRecipeProvenance(localId, kv)?.ownerDid).toBe(owner.did)
  })
})
