/**
 * Wave 1 client/friends fixes (2026-11-20 review round).
 *
 * Covers, per finding:
 * - H-N3: parseMinutes rounds fractional minutes at the form; createRecipe
 *   and updateRecipe round as defense in depth (a stored fraction is
 *   served truncated by the AppView, so the published recipe could never
 *   verify).
 * - S7: a malformed shelf manifest (bad-base64 sig, shares: null, malformed
 *   share ref) lands in failures[] without aborting the other friends'
 *   imports — at processChannel level and at importReceivedShares level.
 * - S8: two pairings on one reused invite get separate channels: the
 *   channel tag is symmetric in the two DIDs, so both sides of one pairing
 *   derive the same room/doc while a second pairing on the same invite
 *   derives different ones; legacy records keep the pairId-only derivation.
 * - S9: oversized/malformed payloads are capped or rejected before
 *   persistence — centrally in the store (create/update), in the friends
 *   upsert path, and in the P2P share path (parse + join).
 *
 * y-webrtc is mocked with a syncing fake (no network): providers in one
 * room exchange Yjs updates, which is exactly what pairing and channel
 * joins need.
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
      // Sync with everyone already in the room, both ways.
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

import { parseMinutes } from '../components/RecipeForm'
import { identityFromSeed } from '../identity/identity'
import {
  buildManifest,
  ensureRecipeKey,
  processChannel,
  publishShare,
  readManifest,
  verifyManifest,
} from '../friends/shelf'
import {
  channelRoomFor,
  channelTagFor,
  createFriendInvite,
  disconnectAllFriendChannels,
  getChannelDoc,
  listFriends,
  runPairing,
  saveFriend,
  shelfGuidFor,
  type FriendRecord,
} from '../friends/friends'
import { importReceivedShares, listReceivedShares } from '../friends/service'
import {
  destroyAllShareProviders,
  getShare,
  joinShare,
  parseSharePayload,
  roomForRecipe,
  type SharePayload,
} from '../p2p/share'
import { createRepo, getRepo } from '../store/repo'
import {
  createRecipe,
  getOrCreateIndex,
  getRecipe,
  listRecipes,
  memoryStore,
  updateRecipe,
} from '../store/recipes'
import type { Recipe, RecipeInput } from '../types'

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

const b64 = (u8: Uint8Array) => Buffer.from(u8).toString('base64')

let dbCounter = 0
const makeRepo = () => createRepo(`longtable-wave1-${++dbCounter}`)
let pairCounter = 0
/**
 * Unique 64-hex pairId per test. The counter varies the HIGH digits:
 * shelfGuidFor/channelRoomFor derive from the first 32 hex chars, so
 * ids that differ only in the low digits would collide into one room.
 */
const freshPairId = () => (++pairCounter).toString(16).padStart(2, '0') + 'ab'.repeat(31)

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
    pairSecret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    pairId,
    signaling: 'wss://test:4444',
    addedAt: '2026-10-12T00:00:00.000Z',
  }
}

/** Snapshot of a recipe doc as a host would embed it in a share payload. */
function snapshotDoc(id: string, setup: (map: Y.Map<unknown>) => void): string {
  const src = new Y.Doc({ guid: id })
  src.transact(() => {
    setup(src.getMap('recipe'))
  })
  const snap = b64(Y.encodeStateAsUpdate(src))
  src.destroy()
  return snap
}

function strArray(items: string[]): Y.Array<string> {
  const arr = new Y.Array<string>()
  arr.push(items)
  return arr
}

let n = 0
const freshId = () => `wave1-share-${++n}-${Date.now()}`

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

describe('H-N3 fractional minutes', () => {
  it('parseMinutes rounds to whole minutes at the form', () => {
    expect(parseMinutes('12.5')).toBe(13)
    expect(parseMinutes('12.4')).toBe(12)
    expect(parseMinutes('7.5')).toBe(8)
    expect(parseMinutes('0')).toBe(0)
    expect(parseMinutes('')).toBeUndefined()
    expect(parseMinutes('abc')).toBeUndefined()
    expect(parseMinutes('-3')).toBeUndefined()
    expect(parseMinutes('  7  ')).toBe(7)
  })

  it('createRecipe and updateRecipe round fractional minutes (defense in depth)', async () => {
    const repo = makeRepo()
    const kv = memoryStore()
    const index = await getOrCreateIndex(repo, kv)
    const input: RecipeInput = {
      title: 'Fractional',
      ingredients: [],
      steps: [],
      photos: [],
      prepMinutes: 12.5,
      cookMinutes: 7.4,
    }
    const summary = await createRecipe(repo, index, input)
    const created = await getRecipe(repo, summary.url)
    expect(created!.prepMinutes).toBe(13)
    expect(created!.cookMinutes).toBe(7)

    await updateRecipe(repo, index, summary.id, { prepMinutes: 2.5, cookMinutes: 3.5 })
    const updated = await getRecipe(repo, summary.url)
    expect(updated!.prepMinutes).toBe(3)
    expect(updated!.cookMinutes).toBe(4)
  })
})

describe('S7 malformed shelf manifests', () => {
  it('verifyManifest returns false (never throws) on a non-base64 sig', async () => {
    const owner = await identityFromSeed(seed(11))
    const friend = await identityFromSeed(seed(22))
    const kv = memoryStore()
    const doc = new Y.Doc()
    const keyRec = await ensureRecipeKey('recipe-0001', kv)
    await publishShare(doc, owner, 'Olga', RECIPE, 'recipe-0001', keyRec, friend.did)
    const manifest = readManifest(doc, owner.did)
    expect(manifest).not.toBeNull()
    expect(await verifyManifest(manifest!)).toBe(true)
    expect(await verifyManifest({ ...manifest!, sig: '!!!not-base64!!!' })).toBe(false)
    expect(await verifyManifest({ ...manifest!, sig: 42 as unknown as string })).toBe(false)
  })

  it('processChannel: a bad-base64 manifest and a shares:null manifest fail without aborting the good share', async () => {
    const owner = await identityFromSeed(seed(11))
    const friend = await identityFromSeed(seed(22))
    const badSig = await identityFromSeed(seed(33))
    const nullShares = await identityFromSeed(seed(44))
    const kv = memoryStore()

    const ownerDoc = new Y.Doc()
    const keyRec = await ensureRecipeKey('recipe-0001', kv)
    await publishShare(ownerDoc, owner, 'Olga', RECIPE, 'recipe-0001', keyRec, friend.did)

    const friendDoc = new Y.Doc()
    Y.applyUpdate(friendDoc, Y.encodeStateAsUpdate(ownerDoc))
    // Poison 1: a manifest whose sig is not base64 (atob used to throw).
    friendDoc.transact(() => {
      friendDoc.getMap('shelf').set(
        `manifest:${badSig.did}`,
        JSON.stringify({
          did: badSig.did,
          name: 'Mallory',
          shares: [{ shareId: 'bad-1', recipeId: 'r-bad', keyId: 'k', updatedAt: '2026-10-12T00:00:00.000Z' }],
          updatedAt: '2026-10-12T00:00:00.000Z',
          sig: '!!!not-base64!!!',
        }),
      )
    })
    // Poison 2: a manifest whose shares is null (for...of used to throw).
    friendDoc.transact(() => {
      friendDoc.getMap('shelf').set(
        `manifest:${nullShares.did}`,
        JSON.stringify({
          did: nullShares.did,
          name: 'Mallory2',
          shares: null,
          updatedAt: '2026-10-12T00:00:00.000Z',
          sig: 'AAAA',
        }),
      )
    })

    const result = await processChannel(friendDoc, friend)
    expect(result.received).toHaveLength(1)
    expect(result.received[0].recipe.title).toBe('Secret Soup')
    const reasons = result.failures.map((f) => `${f.shareId}: ${f.reason}`)
    expect(reasons.some((r) => r.startsWith('bad-1:') && r.includes('signature'))).toBe(true)
    expect(
      reasons.some((r) => r.includes(`manifest:${nullShares.did}`) && r.includes('no shares array')),
    ).toBe(true)
  })

  it('processChannel: a manifest listing a malformed share ref fails that ref only', async () => {
    const owner = await identityFromSeed(seed(11))
    const friend = await identityFromSeed(seed(22))
    const attacker = await identityFromSeed(seed(33))
    const kv = memoryStore()

    const ownerDoc = new Y.Doc()
    const keyRec = await ensureRecipeKey('recipe-0001', kv)
    await publishShare(ownerDoc, owner, 'Olga', RECIPE, 'recipe-0001', keyRec, friend.did)

    // A manifest with a VALID signature over shares:[null] — the ref
    // itself is malformed, so it must fail as one entry, not throw.
    const badManifest = await buildManifest(attacker, 'Mallory', [null as never])
    const friendDoc = new Y.Doc()
    Y.applyUpdate(friendDoc, Y.encodeStateAsUpdate(ownerDoc))
    friendDoc.transact(() => {
      friendDoc.getMap('shelf').set(`manifest:${attacker.did}`, JSON.stringify(badManifest))
    })

    const result = await processChannel(friendDoc, friend)
    expect(result.received).toHaveLength(1)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].shareId).toBe(`manifest:${attacker.did}`)
    expect(result.failures[0].reason).toMatch(/malformed share reference/)
  })

  it('importReceivedShares: a poisoned channel does not abort other friends', async () => {
    const receiver = await identityFromSeed(seed(55))
    const owner1 = await identityFromSeed(seed(11))
    const owner2 = await identityFromSeed(seed(22))
    const attacker = await identityFromSeed(seed(33))
    const kv = memoryStore()
    const repo = makeRepo()

    const rec1 = friendRecord(owner1.did, freshPairId())
    const rec2 = friendRecord(owner2.did, freshPairId())
    saveFriend(rec1, kv)
    saveFriend(rec2, kv)

    // Friend 1's channel: one good share + one poisoned manifest.
    const doc1 = await getChannelDoc(rec1, repo)
    const owner1Doc = new Y.Doc()
    const key1 = await ensureRecipeKey('recipe-0001', kv)
    await publishShare(owner1Doc, owner1, 'Olga', RECIPE, 'recipe-0001', key1, receiver.did)
    Y.applyUpdate(doc1, Y.encodeStateAsUpdate(owner1Doc))
    doc1.transact(() => {
      doc1.getMap('shelf').set(
        `manifest:${attacker.did}`,
        JSON.stringify({
          did: attacker.did,
          name: 'Mallory',
          shares: null,
          updatedAt: '2026-10-12T00:00:00.000Z',
          sig: 'AAAA',
        }),
      )
    })

    // Friend 2's channel: one good share, no poison.
    const doc2 = await getChannelDoc(rec2, repo)
    const owner2Doc = new Y.Doc()
    const key2 = await ensureRecipeKey('recipe-0002', kv)
    await publishShare(
      owner2Doc,
      owner2,
      'Gus',
      { ...RECIPE, title: 'Gus Stew' },
      'recipe-0002',
      key2,
      receiver.did,
    )
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(owner2Doc))

    const failures: Array<{ shareId: string; reason: string }> = []
    const count = await importReceivedShares(receiver, kv, repo, (f) => failures.push(f))
    expect(count).toBe(2)
    expect(failures.some((f) => f.shareId === `manifest:${attacker.did}`)).toBe(true)
    const listed = await listReceivedShares(kv, repo)
    expect(listed.map((s) => s.title).sort()).toEqual(['Gus Stew', 'Secret Soup'])
  })
})

describe('S8 channel binding to friend DID', () => {
  it('channelTagFor is symmetric in the two DIDs and distinct per pair', () => {
    const pairId = 'ab'.repeat(32)
    const didA = 'did:key:z6MkAlice'
    const didB = 'did:key:z6MkBob'
    const didC = 'did:key:z6MkCarol'
    expect(channelTagFor(pairId, didA, didB)).toBe(channelTagFor(pairId, didB, didA))
    expect(channelTagFor(pairId, didA, didB)).not.toBe(channelTagFor(pairId, didA, didC))
    expect(channelTagFor(pairId, didA, didB)).not.toBe(channelTagFor('cd'.repeat(32), didA, didB))
    expect(channelTagFor(pairId, didA, didB)).toMatch(/^[0-9a-f]{32}-[0-9a-f]{16}$/)
  })

  it('legacy records keep the pairId-only derivation; v2 records are DID-bound and differ', () => {
    const pairId = 'ab'.repeat(32)
    const didB = 'did:key:z6MkBob'
    const didC = 'did:key:z6MkCarol'
    const legacyB = friendRecord(didB, pairId)
    const legacyC = friendRecord(didC, pairId)
    // Compat: two legacy pairings on one invite still derive the same
    // room/doc (that is the pre-fix behavior, preserved for old records).
    expect(shelfGuidFor(legacyB)).toBe(`shelf-${pairId.slice(0, 32)}`)
    expect(shelfGuidFor(legacyB)).toBe(shelfGuidFor(legacyC))
    expect(channelRoomFor(legacyB)).toBe(channelRoomFor(legacyC))

    const tagB = channelTagFor(pairId, 'did:key:z6MkAlice', didB)
    const tagC = channelTagFor(pairId, 'did:key:z6MkAlice', didC)
    const v2B = { ...legacyB, channelTag: tagB }
    const v2C = { ...legacyC, channelTag: tagC }
    expect(shelfGuidFor(v2B)).toBe(`shelf-${tagB}`)
    expect(channelRoomFor(v2B)).toBe(`longtable-friend-${tagB}`)
    expect(shelfGuidFor(v2B)).not.toBe(shelfGuidFor(legacyB))
    expect(shelfGuidFor(v2B)).not.toBe(shelfGuidFor(v2C))
    expect(channelRoomFor(v2B)).not.toBe(channelRoomFor(v2C))
  })

  it('two pairings on one reused invite get separate channels (runPairing negotiates v2)', async () => {
    const alice = await identityFromSeed(seed(71))
    const bob = await identityFromSeed(seed(72))
    const carol = await identityFromSeed(seed(73))
    const invite = await createFriendInvite(alice, 'Alice', 'wss://test:4444')
    const kvA = memoryStore()
    const kvB = memoryStore()
    const kvC = memoryStore()

    const [recA1, recB] = await Promise.all([
      runPairing(alice, 'Alice', invite, null, kvA, 10000),
      runPairing(bob, 'Bob', invite, alice.did, kvB, 10000),
    ])
    expect(recA1.did).toBe(bob.did)
    expect(recB.did).toBe(alice.did)
    // Both sides of the one pairing compute the SAME tag and room/doc.
    expect(recA1.channelTag).toBeDefined()
    expect(recA1.channelTag).toBe(recB.channelTag)
    expect(shelfGuidFor(recA1)).toBe(shelfGuidFor(recB))
    expect(channelRoomFor(recA1)).toBe(channelRoomFor(recB))

    // The SAME invite, reused for a second guest: a separate channel.
    const [recA2, recC] = await Promise.all([
      runPairing(alice, 'Alice', invite, null, kvA, 10000),
      runPairing(carol, 'Carol', invite, alice.did, kvC, 10000),
    ])
    expect(recA2.did).toBe(carol.did)
    expect(recC.did).toBe(alice.did)
    expect(recA2.channelTag).toBeDefined()
    expect(recA2.channelTag).not.toBe(recA1.channelTag)
    expect(shelfGuidFor(recA2)).not.toBe(shelfGuidFor(recA1))
    expect(channelRoomFor(recA2)).not.toBe(channelRoomFor(recA1))
    // Alice holds both friends as separate records.
    expect(listFriends(kvA)).toHaveLength(2)
  }, 20000)
})

describe('S9 payload validation and caps', () => {
  it('store caps title, lists, and photos; rejects a non-string title', async () => {
    const repo = makeRepo()
    const kv = memoryStore()
    const index = await getOrCreateIndex(repo, kv)
    const summary = await createRecipe(repo, index, {
      title: 'T'.repeat(600),
      ingredients: Array.from({ length: 600 }, (_, i) => `ingredient ${i}`),
      steps: ['step'],
      photos: Array.from({ length: 25 }, (_, i) => `data:image/png;base64,${i}`),
      prepMinutes: 12.5,
      cookMinutes: 20,
    })
    const loaded = await getRecipe(repo, summary.url)
    expect(loaded!.title).toHaveLength(500)
    expect(loaded!.ingredients).toHaveLength(500)
    expect(loaded!.photos).toHaveLength(20)

    await updateRecipe(repo, index, summary.id, {
      title: 'U'.repeat(700),
      ingredients: Array.from({ length: 600 }, (_, i) => `new ${i}`),
    })
    const updated = await getRecipe(repo, summary.url)
    expect(updated!.title).toHaveLength(500)
    expect(updated!.ingredients).toHaveLength(500)

    await expect(
      createRecipe(repo, index, {
        title: 42,
        ingredients: [],
        steps: [],
        photos: [],
      } as unknown as RecipeInput),
    ).rejects.toThrow(/title/)
    await expect(
      updateRecipe(repo, index, summary.id, { title: 42 } as unknown as { title: string }),
    ).rejects.toThrow(/title/)
  })

  it('store keeps a real photo data URL whole (never slices it to item length)', async () => {
    // Regression: the sanitizer ran photos through the 2000-char
    // text-item slicer, corrupting every real photo (a 46 KB fixture
    // JPEG is a ~61 KB data URL) — the migration proof then saw the
    // <img> with naturalWidth 0. Photos are kept whole; only the count
    // is capped, and non-image entries are dropped.
    const repo = makeRepo()
    const kv = memoryStore()
    const index = await getOrCreateIndex(repo, kv)
    const photo = `data:image/jpeg;base64,${'A'.repeat(70000)}`
    const summary = await createRecipe(repo, index, {
      title: 'Photo Soup',
      ingredients: [],
      steps: [],
      photos: [photo, 'not-a-photo', 'data:image/png;base64,AAAA'],
    })
    const loaded = await getRecipe(repo, summary.url)
    expect(loaded!.photos).toHaveLength(2)
    expect(loaded!.photos[0]).toBe(photo)
    expect(loaded!.photos[0]).toHaveLength(photo.length)

    await updateRecipe(repo, index, summary.id, { photos: [photo] })
    const updated = await getRecipe(repo, summary.url)
    expect(updated!.photos).toHaveLength(1)
    expect(updated!.photos[0]).toBe(photo)
  })

  it('importReceivedShares caps an oversized friend recipe instead of persisting it whole', async () => {
    const receiver = await identityFromSeed(seed(55))
    const owner = await identityFromSeed(seed(11))
    const kv = memoryStore()
    const repo = makeRepo()
    const rec = friendRecord(owner.did, freshPairId())
    saveFriend(rec, kv)

    const big: Recipe = {
      ...RECIPE,
      title: 'B'.repeat(600),
      ingredients: Array.from({ length: 600 }, (_, i) => `ingredient ${i}`),
      steps: ['step'],
      photos: Array.from({ length: 25 }, (_, i) => `data:image/png;base64,${i}`),
      prepMinutes: 12.5,
    }
    const channelDoc = await getChannelDoc(rec, repo)
    const ownerDoc = new Y.Doc()
    const keyRec = await ensureRecipeKey('recipe-big', kv)
    await publishShare(ownerDoc, owner, 'Olga', big, 'recipe-big', keyRec, receiver.did)
    Y.applyUpdate(channelDoc, Y.encodeStateAsUpdate(ownerDoc))

    const count = await importReceivedShares(receiver, kv, repo)
    expect(count).toBe(1)
    const index = await getOrCreateIndex(repo)
    const listed = await listRecipes(index)
    expect(listed).toHaveLength(1)
    const loaded = await getRecipe(repo, listed[0].url)
    expect(loaded!.title).toHaveLength(500)
    expect(loaded!.ingredients).toHaveLength(500)
    expect(loaded!.photos).toHaveLength(20)
    expect(loaded!.prepMinutes).toBe(13)
  })

  it('parseSharePayload rejects snapshots with a non-string title, a non-string item, or oversized lists', async () => {
    const id = freshId()
    const base = {
      v: 1,
      room: roomForRecipe(id),
      signaling: 'wss://test:4444',
      recipeId: id,
      title: 'X',
    }
    const badTitle = snapshotDoc(id, (map) => {
      map.set('title', 123 as unknown as string)
    })
    expect(() => parseSharePayload(JSON.stringify({ ...base, snapshot: badTitle }))).toThrow(
      /not a valid Longtable share/,
    )

    const badItem = snapshotDoc(id, (map) => {
      map.set('title', 'Soup')
      map.set('ingredients', strArray(['1 onion']))
      const arr = map.get('ingredients') as Y.Array<unknown>
      arr.push([42 as unknown as string])
    })
    expect(() => parseSharePayload(JSON.stringify({ ...base, snapshot: badItem }))).toThrow(
      /not a valid Longtable share/,
    )

    const tooMany = snapshotDoc(id, (map) => {
      map.set('title', 'Soup')
      map.set(
        'ingredients',
        strArray(Array.from({ length: 600 }, (_, i) => `ingredient ${i}`)),
      )
    })
    expect(() => parseSharePayload(JSON.stringify({ ...base, snapshot: tooMany }))).toThrow(
      /not a valid Longtable share/,
    )

    const tooManyPhotos = snapshotDoc(id, (map) => {
      map.set('title', 'Soup')
      map.set(
        'photos',
        strArray(Array.from({ length: 25 }, (_, i) => `data:image/png;base64,${i}`)),
      )
    })
    expect(() => parseSharePayload(JSON.stringify({ ...base, snapshot: tooManyPhotos }))).toThrow(
      /not a valid Longtable share/,
    )
  })

  it('joinShare registers the validated doc title, not an oversized payload.title', async () => {
    const id = freshId()
    const snapshot = snapshotDoc(id, (map) => {
      map.set('title', 'Real Title')
      map.set('ingredients', strArray(['1 onion']))
    })
    const payload: SharePayload = {
      v: 1,
      room: roomForRecipe(id),
      signaling: 'wss://test:4444',
      recipeId: id,
      title: 'Y'.repeat(10000),
      snapshot,
    }
    await joinShare(payload)
    const index = await getOrCreateIndex(getRepo())
    const listed = await listRecipes(index)
    // The default repo is shared across tests in this file, so assert by
    // id rather than by exact list contents.
    expect(listed.find((s) => s.id === id)?.title).toBe('Real Title')
  })

  it('joinShare rejects an oversized snapshot even when called directly (no parse)', async () => {
    const id = freshId()
    const snapshot = snapshotDoc(id, (map) => {
      map.set('title', 'Too Many Photos')
      map.set(
        'photos',
        strArray(Array.from({ length: 25 }, (_, i) => `data:image/png;base64,${i}`)),
      )
    })
    const payload: SharePayload = {
      v: 1,
      room: roomForRecipe(id),
      signaling: 'wss://test:4444',
      recipeId: id,
      title: 'Too Many Photos',
      snapshot,
    }
    await expect(joinShare(payload)).rejects.toThrow(/too many photos/)
    // No share record was saved and the recipe was never registered (the
    // default repo's index is shared across tests in this file, so assert
    // by id rather than by exact list contents).
    expect(getShare(id)).toBeUndefined()
    const index = await getOrCreateIndex(getRepo())
    expect((await listRecipes(index)).some((s) => s.id === id)).toBe(false)
  })
})
