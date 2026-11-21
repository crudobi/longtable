/**
 * Wave 4B visibility / import / API-honesty tests (2026-11-20 review round).
 *
 * Covers, per finding:
 * - H6: signed delete tombstones — build/verify, publish clears them,
 *   unpublish writes them, processChannel returns only verified ones,
 *   a live share beats a stale tombstone, and importChannelDoc deletes
 *   the friend's received copy on the next sync.
 * - H10: URL-import photos are re-hosted as data URLs (fetch + cap +
 *   type checks) and dropped photos are named in warnings, never stored
 *   as remote URLs.
 * - H11: createRecipesAtomic — a mid-loop store failure rolls back what
 *   was already created and says what failed; nothing is left behind.
 * - H12/H13 (router-level): see localapi.test.ts — the confirm gate and
 *   warnings arrays. The flow-level warnings (tombstone recall limit)
 *   are covered here; the signed-out public-copy refusal (H5, Wave 6B)
 *   is covered here and in wave6b-h5.test.ts.
 * - M-N2: save-a-copy fetches from the AUTHOR's PDS (hint first, PLC
 *   only on a miss) and hash-checks bytes against the CID.
 * - M2(int): client CID check on uploadBlob, the 5 MiB photo cap, and
 *   deleteBlob orphan cleanup on a failed publish.
 *
 * y-webrtc is mocked with a syncing fake (copied from wave1-client):
 * the unshare/delete-flow tests need a channel doc without a network.
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

import { identityFromSeed } from '../identity/identity'
import { u8ToBase64 } from '../identity/codec'
import {
  buildTombstone,
  deleteTombstone,
  dropRecipeKey,
  ensureRecipeKey,
  processChannel,
  publishShare,
  readTombstones,
  setKeyFriends,
  unpublishShare,
  verifyTombstone,
  writeTombstone,
} from '../friends/shelf'
import {
  applyTombstones,
  importChannelDoc,
  receivedKey,
  unshareRecipeEverywhere,
  type ReceivedMapping,
} from '../friends/service'
import {
  disconnectFriendChannel,
  getChannelDoc,
  pairIdFor,
  saveFriend,
  type FriendRecord,
} from '../friends/friends'
import { createRepo, getRepo } from '../store/repo'
import {
  createRecipe,
  createRecipesAtomic,
  getOrCreateIndex,
  getRecipe,
  listRecipes,
  memoryStore,
} from '../store/recipes'
import { fetchRemotePhotos } from '../importers/urlImport'
import { MAX_PHOTO_BYTES } from '../importers/photoImport'
import { blobMatchesCid, cidForBytes, cidSha256Digest } from '../public/blobCid'
import {
  fetchAuthorPhotoBytes,
  publicRecordToInput,
  type PublicRecipe,
} from '../public/discover'
import { AtprotoClient, PUBLICATIONS_KEY, type AtprotoSession } from '../public/atproto'
import {
  publishRecipe,
  type PublishableRecipe,
} from '../public/publish'
import {
  PublicCopyLiveError,
  TOMBSTONE_NOTICE,
  applyVisibilityFlow,
  performDeleteFlow,
} from '../recipeFlows'
import type { Recipe, RecipeInput } from '../types'

const seed = (n: number) => new Uint8Array(32).fill(n)

function syncDocs(a: Y.Doc, b: Y.Doc): void {
  const ua = Y.encodeStateAsUpdate(a)
  const ub = Y.encodeStateAsUpdate(b)
  Y.applyUpdate(b, ua)
  Y.applyUpdate(a, ub)
}

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
const RECIPE_ID = 'recipe-0001'


// The flows under test read bare `localStorage` through default
// parameters (getOrCreateIndex, getPublication) — the node test env
// has none, so each test installs an empty one (leaveshare pattern).
function mkLocalStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map<string, string>(Object.entries(seed))
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    length: 0,
  } as Storage
}

beforeEach(() => {
  ;(globalThis as { localStorage?: Storage }).localStorage = mkLocalStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as { localStorage?: Storage }).localStorage
})

// ---------------------------------------------------------------------------
// M2(int): blob CID verification
// ---------------------------------------------------------------------------

describe('blob CID check (M2(int))', () => {
  it('cidForBytes round-trips through blobMatchesCid', async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 250])
    const cid = await cidForBytes(bytes)
    expect(cid.startsWith('b')).toBe(true)
    expect(await blobMatchesCid(cid, bytes)).toBe(true)
    expect(cidSha256Digest(cid)).toHaveLength(32)
  })

  it('wrong bytes, malformed CIDs, and CIDv0 all fail closed', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const cid = await cidForBytes(bytes)
    expect(await blobMatchesCid(cid, new Uint8Array([1, 2, 3, 5]))).toBe(false)
    for (const bad of ['', 'not-a-cid', 'bafy', 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG']) {
      expect(await blobMatchesCid(bad, bytes)).toBe(false)
      expect(cidSha256Digest(bad)).toBeNull()
    }
  })

  it('the photo cap is 5 MiB', () => {
    expect(MAX_PHOTO_BYTES).toBe(5 * 1024 * 1024)
  })
})

// ---------------------------------------------------------------------------
// H6: tombstones
// ---------------------------------------------------------------------------

describe('delete tombstones (H6)', () => {
  it('build + verify round-trips; tampering fails', async () => {
    const owner = await identityFromSeed(seed(11))
    const t = await buildTombstone(owner, 'r-1')
    expect(t.ownerDid).toBe(owner.did)
    expect(t.recipeId).toBe('r-1')
    expect(await verifyTombstone(t)).toBe(true)
    expect(await verifyTombstone({ ...t, recipeId: 'r-2' })).toBe(false)
    expect(await verifyTombstone({ ...t, ownerDid: 'did:key:z6MkOther' })).toBe(false)
    expect(await verifyTombstone({ ...t, sig: `${t.sig.slice(0, -2)}AA` })).toBe(false)
    expect(await verifyTombstone(null as unknown as never)).toBe(false)
    expect(await verifyTombstone({} as unknown as never)).toBe(false)
  })

  it('write / read / delete round-trips in the shelf doc', async () => {
    const owner = await identityFromSeed(seed(11))
    const doc = new Y.Doc()
    const t = await buildTombstone(owner, 'r-1')
    writeTombstone(doc, t)
    expect(readTombstones(doc)).toHaveLength(1)
    expect(readTombstones(doc)[0].recipeId).toBe('r-1')
    deleteTombstone(doc, 'r-1')
    expect(readTombstones(doc)).toHaveLength(0)
  })

  it('publishShare clears a tombstone; unpublishShare writes a verified one', async () => {
    const owner = await identityFromSeed(seed(11))
    const friend = await identityFromSeed(seed(22))
    const kv = memoryStore()
    const doc = new Y.Doc()
    const keyRec = await ensureRecipeKey(RECIPE_ID, kv)
    // A stale tombstone is in the doc before the (re-)share.
    writeTombstone(doc, await buildTombstone(owner, RECIPE_ID))
    await publishShare(doc, owner, 'Olga', RECIPE, RECIPE_ID, keyRec, friend.did)
    expect(readTombstones(doc)).toHaveLength(0)

    await unpublishShare(doc, owner, 'Olga', RECIPE_ID, friend.did)
    const tombs = readTombstones(doc)
    expect(tombs).toHaveLength(1)
    expect(await verifyTombstone(tombs[0])).toBe(true)

    // The friend's replica sees the tombstone, not a share.
    const replica = new Y.Doc()
    syncDocs(doc, replica)
    const res = await processChannel(replica, friend)
    expect(res.received).toEqual([])
    expect(res.tombstones).toHaveLength(1)
    expect(res.tombstones[0].recipeId).toBe(RECIPE_ID)
    expect(res.failures).toEqual([])
  })

  it('a forged tombstone lands in failures and deletes nothing', async () => {
    const owner = await identityFromSeed(seed(11))
    const friend = await identityFromSeed(seed(22))
    const doc = new Y.Doc()
    const t = await buildTombstone(owner, RECIPE_ID)
    writeTombstone(doc, { ...t, recipeId: 'recipe-forged' })
    const res = await processChannel(doc, friend)
    expect(res.tombstones).toEqual([])
    expect(res.failures.length).toBeGreaterThan(0)
    expect(res.failures[0].reason).toMatch(/did not verify/)
  })

  it('a live share beats a stale tombstone for the same recipe', async () => {
    const owner = await identityFromSeed(seed(11))
    const friend = await identityFromSeed(seed(22))
    const kv = memoryStore()
    const doc = new Y.Doc()
    const keyRec = await ensureRecipeKey(RECIPE_ID, kv)
    await publishShare(doc, owner, 'Olga', RECIPE, RECIPE_ID, keyRec, friend.did)
    // The owner deleted, then re-shared — the tombstone is stale.
    writeTombstone(doc, await buildTombstone(owner, RECIPE_ID))
    const res = await processChannel(doc, friend)
    expect(res.received).toHaveLength(1)
    expect(res.tombstones).toEqual([])
  })

  it('importChannelDoc: share → copy exists → unpublish → copy is recalled', async () => {
    const repo = createRepo('longtable-wave4b-tombstone-1')
    const kv = memoryStore()
    const index = await getOrCreateIndex(repo, kv)
    const mapping: Record<string, ReceivedMapping> = {}
    const owner = await identityFromSeed(seed(11))
    const friend = await identityFromSeed(seed(22))
    const ownerDoc = new Y.Doc()
    const keyRec = await ensureRecipeKey(RECIPE_ID, kv)
    await publishShare(ownerDoc, owner, 'Olga', RECIPE, RECIPE_ID, keyRec, friend.did)

    const friendDoc = new Y.Doc()
    syncDocs(ownerDoc, friendDoc)
    const first = await importChannelDoc(friendDoc, friend, index, mapping, repo)
    expect(first.imported).toBe(1)
    expect(first.tombstonesApplied).toBe(0)
    expect((await listRecipes(index)).map((r) => r.title)).toEqual(['Secret Soup'])
    expect(mapping[receivedKey(owner.did, RECIPE_ID)]).toBeDefined()

    await unpublishShare(ownerDoc, owner, 'Olga', RECIPE_ID, friend.did)
    syncDocs(ownerDoc, friendDoc)
    const second = await importChannelDoc(friendDoc, friend, index, mapping, repo)
    expect(second.imported).toBe(0)
    expect(second.tombstonesApplied).toBe(1)
    expect(await listRecipes(index)).toEqual([])
    expect(mapping[receivedKey(owner.did, RECIPE_ID)]).toBeUndefined()

    // A further import is a no-op: the tombstone has nothing left to delete.
    const third = await importChannelDoc(friendDoc, friend, index, mapping, repo)
    expect(third.tombstonesApplied).toBe(0)
  })

  it('applyTombstones: a tombstone for a never-received recipe is a no-op', async () => {
    const repo = createRepo('longtable-wave4b-tombstone-2')
    const kv = memoryStore()
    const index = await getOrCreateIndex(repo, kv)
    const mapping: Record<string, ReceivedMapping> = {}
    const owner = await identityFromSeed(seed(11))
    const t = await buildTombstone(owner, 'never-received')
    expect(await applyTombstones([t], mapping, index, repo)).toBe(0)
  })

  it('unshareRecipeEverywhere returns the DIDs and writes their tombstones', async () => {
    const owner = await identityFromSeed(seed(51))
    const friend = await identityFromSeed(seed(52))
    const secret = u8ToBase64(new Uint8Array(32).fill(5))
    const pairId = await pairIdFor(secret)
    const friendRec: FriendRecord = {
      did: friend.did,
      name: 'Fay',
      pairSecret: secret,
      pairId,
      signaling: 'wss://example:4444',
      addedAt: '2026-10-12T00:00:00.000Z',
    }
    saveFriend(friendRec)
    const keyRec = await ensureRecipeKey('wave4b-tomb-1')
    // unshareRecipeEverywhere loops the key record's friends list —
    // ensureRecipeKey leaves it empty, so list the friend explicitly.
    setKeyFriends('wave4b-tomb-1', [friend.did])
    const doc = await getChannelDoc(friendRec)
    await publishShare(doc, owner, 'Olga', RECIPE, 'wave4b-tomb-1', keyRec, friend.did)
    const sharedWith = await unshareRecipeEverywhere('wave4b-tomb-1', owner)
    expect(sharedWith).toEqual([friend.did])
    const tombs = readTombstones(doc)
    expect(tombs).toHaveLength(1)
    expect(await verifyTombstone(tombs[0])).toBe(true)
    disconnectFriendChannel(friend.did)
    dropRecipeKey('wave4b-tomb-1')
  })

  it('delete flow reports the tombstone recall limit (H13)', async () => {
    const owner = await identityFromSeed(seed(51))
    const friend = await identityFromSeed(seed(52))
    // Re-establish the share from scratch (same DIDs as the unshare
    // test above; each test installs a fresh localStorage stub).
    const secret = u8ToBase64(new Uint8Array(32).fill(5))
    const friendRec: FriendRecord = {
      did: friend.did,
      name: 'Fay',
      pairSecret: secret,
      pairId: await pairIdFor(secret),
      signaling: 'wss://example:4444',
      addedAt: '2026-10-12T00:00:00.000Z',
    }
    saveFriend(friendRec)
    const keyRec = await ensureRecipeKey('wave4b-tomb-2')
    setKeyFriends('wave4b-tomb-2', [friend.did])
    const doc = await getChannelDoc(friendRec)
    await publishShare(doc, owner, 'Olga', RECIPE, 'wave4b-tomb-2', keyRec, friend.did)
    const warnings = await performDeleteFlow('wave4b-tomb-2', { identity: owner })
    expect(warnings).toContain(TOMBSTONE_NOTICE)
    disconnectFriendChannel(friend.did)
    dropRecipeKey('wave4b-tomb-2')
  })
})

// ---------------------------------------------------------------------------
// H10: URL-import photos are re-hosted, never stored as remote URLs
// ---------------------------------------------------------------------------

describe('URL-import photos (H10)', () => {
  const photoBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9])
  const okPhoto = () =>
    new Response(photoBytes, {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })

  it('fetchRemotePhotos re-hosts a good photo and drops nothing', async () => {
    let fetched = 0
    const { photos, warnings } = await fetchRemotePhotos(
      ['https://example.com/pancakes.jpg'],
      {
        fetchFn: async () => {
          fetched++
          return okPhoto()
        },
        toDataUrl: async () => 'data:image/png;base64,STUB',
      },
    )
    expect(photos).toEqual(['data:image/png;base64,STUB'])
    expect(warnings).toEqual([])
    expect(fetched).toBe(1)
  })

  it('fetchRemotePhotos drops each bad photo with a reason naming the URL', async () => {
    const fetchFn = async (url: string): Promise<Response> => {
      if (url.endsWith('404.jpg')) return new Response('nope', { status: 404 })
      if (url.endsWith('html.jpg')) {
        return new Response('<html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      }
      if (url.endsWith('big.jpg')) {
        return new Response(photoBytes, {
          status: 200,
          headers: {
            'content-type': 'image/png',
            'content-length': String(MAX_PHOTO_BYTES + 1),
          },
        })
      }
      if (url.endsWith('empty.jpg')) {
        return new Response(new Uint8Array(0), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        })
      }
      return okPhoto()
    }
    const { photos, warnings } = await fetchRemotePhotos(
      [
        'https://example.com/404.jpg',
        'https://example.com/html.jpg',
        'https://example.com/big.jpg',
        'https://example.com/empty.jpg',
        'https://example.com/good.jpg',
      ],
      { fetchFn, toDataUrl: async () => 'data:image/png;base64,STUB' },
    )
    expect(photos).toEqual(['data:image/png;base64,STUB'])
    expect(warnings).toHaveLength(4)
    expect(warnings[0]).toMatch(/404\.jpg.*HTTP 404/)
    expect(warnings[1]).toMatch(/html\.jpg.*not an image/)
    expect(warnings[2]).toMatch(/big\.jpg.*larger than/)
    expect(warnings[3]).toMatch(/empty\.jpg.*empty file/)
  })

  it('fetchRemotePhotos drops an over-cap body even without a content-length', async () => {
    const big = new Uint8Array(MAX_PHOTO_BYTES + 1)
    const { photos, warnings } = await fetchRemotePhotos(['https://example.com/big.jpg'], {
      fetchFn: async () =>
        new Response(big, { status: 200, headers: { 'content-type': 'image/png' } }),
      toDataUrl: async () => 'data:image/png;base64,STUB',
    })
    expect(photos).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/larger than/)
  })

  it('fetchRemotePhotos dedupes and caps at 20 photos', async () => {
    let fetched = 0
    const urls = Array.from({ length: 21 }, (_, i) => `https://example.com/p${i}.jpg`)
    urls.push(urls[0])
    const { photos, warnings } = await fetchRemotePhotos(urls, {
      fetchFn: async () => {
        fetched++
        return okPhoto()
      },
      toDataUrl: async () => 'data:image/png;base64,STUB',
    })
    expect(photos).toHaveLength(20)
    expect(fetched).toBe(20)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/only the first 20 photos/)
  })

})

// ---------------------------------------------------------------------------
// H11: import atomicity
// ---------------------------------------------------------------------------

describe('atomic import (H11)', () => {
  let repoCounter = 0
  const soup: RecipeInput = {
    title: 'Atomic Soup',
    ingredients: ['water'],
    steps: ['Boil.'],
    photos: [],
  }
  const salad: RecipeInput = {
    title: 'Atomic Salad',
    ingredients: ['leaves'],
    steps: ['Toss.'],
    photos: [],
  }

  it('creates every recipe on success', async () => {
    repoCounter++
    const repo = createRepo(`longtable-wave4b-atomic-${repoCounter}`)
    const index = await getOrCreateIndex(repo, memoryStore())
    const ids = await createRecipesAtomic(repo, index, [soup, salad])
    expect(ids).toHaveLength(2)
    expect((await listRecipes(index)).map((r) => r.title).sort()).toEqual([
      'Atomic Salad',
      'Atomic Soup',
    ])
  })

  it('a mid-loop failure rolls back and names the failing recipe', async () => {
    repoCounter++
    const repo = createRepo(`longtable-wave4b-atomic-${repoCounter}`)
    const index = await getOrCreateIndex(repo, memoryStore())
    const bad = { title: 123, ingredients: [], steps: [] } as unknown as RecipeInput
    await expect(createRecipesAtomic(repo, index, [soup, bad])).rejects.toThrow(
      /Import failed at recipe 2 of 2: Recipe title must be text\./,
    )
    await expect(createRecipesAtomic(repo, index, [soup, bad])).rejects.toThrow(
      /removed, so nothing was imported/,
    )
    expect(await listRecipes(index)).toEqual([])
  })

  it('a first-recipe failure imports nothing and says so', async () => {
    repoCounter++
    const repo = createRepo(`longtable-wave4b-atomic-${repoCounter}`)
    const index = await getOrCreateIndex(repo, memoryStore())
    const bad = { title: 123, ingredients: [], steps: [] } as unknown as RecipeInput
    await expect(createRecipesAtomic(repo, index, [bad])).rejects.toThrow(
      /Import failed at recipe 1 of 1: Recipe title must be text\. Nothing was imported\./,
    )
    expect(await listRecipes(index)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// M-N2: save-a-copy fetches from the author's PDS and checks the CID
// ---------------------------------------------------------------------------

describe('author-PDS photo fetch (M-N2)', () => {
  const AUTHOR_DID = 'did:plc:author1'
  const HINT_PDS = 'https://viewer-pds.test'
  const AUTHOR_PDS = 'https://author-pds.test'
  const PLC_URL = 'https://plc.test'
  const photoBytes = new Uint8Array([9, 8, 7, 6, 5])

  interface PhotoStub {
    hint: (url: string) => Promise<Response>
    author: (url: string) => Promise<Response>
    plc: (url: string) => Promise<Response>
  }

  const blobResponse = (bytes: Uint8Array) =>
    new Response(bytes.slice().buffer, {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    })
  const notFound = () =>
    new Response(JSON.stringify({ error: 'BlobNotFound', message: 'blob not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  const plcDoc = (withPds: boolean) =>
    new Response(
      JSON.stringify({
        id: AUTHOR_DID,
        service: withPds
          ? [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: AUTHOR_PDS }]
          : [],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )

  const makeFetch = (stub: PhotoStub) => {
    const calls: string[] = []
    const fetchFn = async (url: string): Promise<Response> => {
      calls.push(url)
      if (url.startsWith(HINT_PDS)) return stub.hint(url)
      if (url.startsWith(AUTHOR_PDS)) return stub.author(url)
      if (url.startsWith(PLC_URL)) return stub.plc(url)
      return notFound()
    }
    return { fetchFn, calls }
  }

  it('a working hint is used with no PLC round trip', async () => {
    const cid = await cidForBytes(photoBytes)
    const { fetchFn, calls } = makeFetch({
      hint: async () => blobResponse(photoBytes),
      author: async () => {
        throw new Error('author PDS must not be fetched')
      },
      plc: async () => {
        throw new Error('PLC must not be consulted')
      },
    })
    const out = await fetchAuthorPhotoBytes(AUTHOR_DID, cid, fetchFn, {
      authorPdsUrl: HINT_PDS,
      plcUrl: PLC_URL,
    })
    expect(out).toEqual(photoBytes)
    expect(calls.some((u) => u.includes('plc.test'))).toBe(false)
    expect(calls.some((u) => u.startsWith(AUTHOR_PDS))).toBe(false)
  })

  it('a hint 404 falls through to the PLC-resolved author PDS', async () => {
    const cid = await cidForBytes(photoBytes)
    const { fetchFn, calls } = makeFetch({
      hint: async () => notFound(),
      author: async () => blobResponse(photoBytes),
      plc: async () => plcDoc(true),
    })
    const out = await fetchAuthorPhotoBytes(AUTHOR_DID, cid, fetchFn, {
      authorPdsUrl: HINT_PDS,
      plcUrl: PLC_URL,
    })
    expect(out).toEqual(photoBytes)
    expect(calls.some((u) => u.startsWith(PLC_URL))).toBe(true)
    expect(calls.some((u) => u.startsWith(AUTHOR_PDS))).toBe(true)
  })

  it('a CID mismatch fails closed with no fallthrough to the author PDS', async () => {
    const cid = await cidForBytes(photoBytes)
    const wrong = new Uint8Array([1, 1, 1, 1, 1])
    const { fetchFn, calls } = makeFetch({
      hint: async () => blobResponse(wrong),
      author: async () => {
        throw new Error('author PDS must not be fetched after a CID mismatch')
      },
      plc: async () => plcDoc(true),
    })
    await expect(
      fetchAuthorPhotoBytes(AUTHOR_DID, cid, fetchFn, {
        authorPdsUrl: HINT_PDS,
        plcUrl: PLC_URL,
      }),
    ).rejects.toThrow(/content check/)
    expect(calls.some((u) => u.startsWith(AUTHOR_PDS))).toBe(false)
  })

  it('an over-cap photo is refused before it is stored', async () => {
    const big = new Uint8Array(MAX_PHOTO_BYTES + 1)
    const cid = await cidForBytes(big)
    const { fetchFn } = makeFetch({
      hint: async () => blobResponse(big),
      author: async () => notFound(),
      plc: async () => plcDoc(true),
    })
    await expect(
      fetchAuthorPhotoBytes(AUTHOR_DID, cid, fetchFn, {
        authorPdsUrl: HINT_PDS,
        plcUrl: PLC_URL,
      }),
    ).rejects.toThrow(/larger than/)
  })

  it('no PDS anywhere is a plain failure, and no PDS in the DID doc is, too', async () => {
    const cid = await cidForBytes(photoBytes)
    const { fetchFn } = makeFetch({
      hint: async () => notFound(),
      author: async () => notFound(),
      plc: async () => plcDoc(true),
    })
    await expect(
      fetchAuthorPhotoBytes(AUTHOR_DID, cid, fetchFn, {
        authorPdsUrl: HINT_PDS,
        plcUrl: PLC_URL,
      }),
    ).rejects.toThrow(/blob not found/)
    const noPds = makeFetch({
      hint: async () => notFound(),
      author: async () => notFound(),
      plc: async () => plcDoc(false),
    })
    await expect(
      fetchAuthorPhotoBytes(AUTHOR_DID, cid, noPds.fetchFn, { plcUrl: PLC_URL }),
    ).rejects.toThrow(/Could not find the author's photo server/)
  })

  it('publicRecordToInput reports skipped photos instead of dropping them silently', async () => {
    const record = {
      did: 'did:plc:author1',
      images: [
        { $type: 'blob', ref: { $link: 'cid1' }, mimeType: 'image/jpeg', size: 3 },
        { $type: 'blob', ref: { $link: 'cid2' }, mimeType: 'image/jpeg', size: 3 },
      ],
    } as unknown as PublicRecipe
    const skipped: Array<[string, string]> = []
    const input = await publicRecordToInput(
      record,
      async (cid) => {
        if (cid === 'cid1') return 'data:image/jpeg;base64,AAA'
        throw new Error('photo gone')
      },
      (cid, reason) => {
        skipped.push([cid, reason])
      },
    )
    expect(input.photos).toEqual(['data:image/jpeg;base64,AAA'])
    expect(skipped).toEqual([['cid2', 'photo gone']])
  })
})

// ---------------------------------------------------------------------------
// M2(int): publish-side CID check, byte cap, orphan cleanup
// ---------------------------------------------------------------------------

describe('publish photo safety (M2(int))', () => {
  const PDS = 'http://localhost:2583'
  const ACCT = 'did:plc:accttest'
  const SEED = new Uint8Array(32).fill(9)
  const PHOTO_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 250])
  const PHOTO_URL = `data:image/png;base64,${u8ToBase64(PHOTO_BYTES)}`

  function fixtureRecipe(): PublishableRecipe {
    return {
      id: 'recipe-1',
      title: 'Tomato Soup',
      ingredients: ['tomatoes', 'salt'],
      steps: ['Chop', 'Simmer'],
      photos: [PHOTO_URL],
      prepMinutes: 5,
      cookMinutes: 25,
      createdAt: '2026-01-01T10:00:00.000Z',
      updatedAt: '2026-01-02T10:00:00.000Z',
    }
  }

  function makeSession(): AtprotoSession {
    return {
      did: ACCT,
      handle: 'alice.test',
      pdsUrl: PDS,
      accessJwt: 'access-1',
      refreshJwt: 'refresh-1',
    }
  }

  /** Fake PDS: 'real' returns the true CID for uploaded bytes, 'wrong' a CID for other bytes. */
  function makePublishFake(mode: 'real' | 'wrong') {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = []
    const deleted: string[] = []
    const json = (obj: unknown, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    const fetchFn = async (url: string, init: RequestInit = {}): Promise<Response> => {
      const u = new URL(url)
      const path = u.pathname.replace(/^\/xrpc\//, '')
      const body =
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {}
      switch (path) {
        case 'com.atproto.repo.getRecord':
          return json({ error: 'RecordNotFound', message: 'Record not found' }, 400)
        case 'com.atproto.repo.putRecord': {
          calls.push({ path, body })
          return json({
            uri: `at://${body.repo as string}/${body.collection as string}/${body.rkey as string}`,
            cid: 'bafyrec1',
          })
        }
        case 'com.atproto.repo.uploadBlob': {
          calls.push({ path, body: {} })
          const bytes = new Uint8Array(init.body as Uint8Array)
          const cid =
            mode === 'real'
              ? await cidForBytes(bytes)
              : await cidForBytes(new Uint8Array([0]))
          return json({
            blob: { $type: 'blob', ref: { $link: cid }, mimeType: 'image/png', size: bytes.length },
          })
        }
        case 'com.atproto.repo.deleteBlob': {
          calls.push({ path, body })
          deleted.push((body as { cid: string }).cid)
          return json({})
        }
        default:
          return json({ error: 'Unknown', message: `no fake endpoint: ${path}` }, 404)
      }
    }
    return { fetchFn, calls, deleted }
  }

  it('publishes with a verified CID and deletes nothing', async () => {
    const fake = makePublishFake('real')
    const client = new AtprotoClient(PDS, { fetchFn: fake.fetchFn })
    const identity = await identityFromSeed(SEED)
    const kv = memoryStore()
    const uri = await publishRecipe(client, makeSession(), identity, fixtureRecipe(), kv)
    expect(uri).toBe(`at://${ACCT}/kitchen.longtable.recipe/recipe-1`)
    const recPut = fake.calls.find(
      (c) => (c.body.collection as string) === 'kitchen.longtable.recipe',
    )
    expect(recPut).toBeDefined()
    const images = (recPut!.body.record as Record<string, unknown>).images as Array<{
      ref: { $link: string }
    }>
    expect(images[0].ref.$link).toBe(await cidForBytes(PHOTO_BYTES))
    expect(fake.deleted).toEqual([])
  })

  it('a CID mismatch aborts the publish and deletes the orphaned blob', async () => {
    const fake = makePublishFake('wrong')
    const client = new AtprotoClient(PDS, { fetchFn: fake.fetchFn })
    const identity = await identityFromSeed(SEED)
    const kv = memoryStore()
    await expect(
      publishRecipe(client, makeSession(), identity, fixtureRecipe(), kv),
    ).rejects.toThrow(/content address/)
    expect(fake.deleted).toHaveLength(1)
    expect(fake.deleted[0]).toBe(await cidForBytes(new Uint8Array([0])))
    expect(
      fake.calls.some((c) => (c.body.collection as string) === 'kitchen.longtable.recipe'),
    ).toBe(false)
  })

  it('an over-cap photo is refused before any upload', async () => {
    const fake = makePublishFake('real')
    const client = new AtprotoClient(PDS, { fetchFn: fake.fetchFn })
    const identity = await identityFromSeed(SEED)
    const kv = memoryStore()
    const big = new Uint8Array(MAX_PHOTO_BYTES + 1)
    const recipe: PublishableRecipe = {
      ...fixtureRecipe(),
      photos: [`data:image/png;base64,${u8ToBase64(big)}`],
    }
    await expect(publishRecipe(client, makeSession(), identity, recipe, kv)).rejects.toThrow(
      /too large to publish/,
    )
    expect(fake.calls.some((c) => c.path === 'com.atproto.repo.uploadBlob')).toBe(false)
  })

  it('deleteBlob sends the CID to the PDS', async () => {
    const fake = makePublishFake('real')
    const client = new AtprotoClient(PDS, { fetchFn: fake.fetchFn })
    await client.deleteBlob(makeSession(), 'bafytestcid')
    expect(fake.calls).toContainEqual({
      path: 'com.atproto.repo.deleteBlob',
      body: { cid: 'bafytestcid' },
    })
  })
})

// ---------------------------------------------------------------------------
// H13: flow-level warnings (delete / visibility, signed-out public copy)
// ---------------------------------------------------------------------------

describe('flow warnings (H13)', () => {
  it('delete with a live public record and no session is refused, local copy stays', async () => {
    const repo = getRepo()
    const index = await getOrCreateIndex(repo, memoryStore())
    const { id } = await createRecipe(repo, index, {
      title: 'Public Stew',
      ingredients: ['beef'],
      steps: ['Simmer.'],
      photos: [],
      visibility: 'public',
    })
    const pubKv = memoryStore()
    pubKv.setItem(
      PUBLICATIONS_KEY,
      JSON.stringify({
        [id]: {
          did: 'did:plc:accttest',
          uri: `at://did:plc:accttest/kitchen.longtable.recipe/${id}`,
          rkey: id,
          cid: 'bafyrec1',
          pdsUrl: 'http://localhost:2583',
          updatedAt: '2026-01-01T10:00:00.000Z',
        },
      }),
    )
    // H5 (Wave 6B): refused before any mutation — the message
    // names the public copy still listed, and the local copy stays.
    let refusal: unknown
    try {
      await performDeleteFlow(id, { identity: null, publicationsKv: pubKv })
    } catch (e) {
      refusal = e
    }
    expect(refusal).toBeInstanceOf(PublicCopyLiveError)
    expect((refusal as Error).message).toMatch(/public copy is still listed/)
    expect((await listRecipes(index)).some((r) => r.id === id)).toBe(true)
  })

  it('a private flip with a live public record and no session is refused, tier stays public', async () => {
    const repo = getRepo()
    const index = await getOrCreateIndex(repo, memoryStore())
    const { id } = await createRecipe(repo, index, {
      title: 'Public Pie',
      ingredients: ['apples'],
      steps: ['Bake.'],
      photos: [],
      visibility: 'public',
    })
    const pubKv = memoryStore()
    pubKv.setItem(
      PUBLICATIONS_KEY,
      JSON.stringify({
        [id]: {
          did: 'did:plc:accttest',
          uri: `at://did:plc:accttest/kitchen.longtable.recipe/${id}`,
          rkey: id,
          cid: 'bafyrec1',
          pdsUrl: 'http://localhost:2583',
          updatedAt: '2026-01-01T10:00:00.000Z',
        },
      }),
    )
    const recipe: Recipe = {
      title: 'Public Pie',
      ingredients: ['apples'],
      steps: ['Bake.'],
      photos: [],
      createdAt: '2026-01-01T10:00:00.000Z',
      updatedAt: '2026-01-01T10:00:00.000Z',
      visibility: 'public',
    }
    // H5 (Wave 6B): refused before any mutation — the tier stays public.
    let refusal: unknown
    try {
      await applyVisibilityFlow(id, recipe, 'private', {
        identity: null,
        publicationsKv: pubKv,
      })
    } catch (e) {
      refusal = e
    }
    expect(refusal).toBeInstanceOf(PublicCopyLiveError)
    expect((refusal as Error).message).toMatch(/public copy is still listed/)
    // listRecipes summaries carry no visibility — read the doc itself.
    const summary = (await listRecipes(index)).find((r) => r.id === id)
    expect(summary).toBeDefined()
    const after = await getRecipe(repo, summary!.url)
    expect(after?.visibility).toBe('public')
  })
})
