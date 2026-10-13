/**
 * Friends-only sharing unit tests.
 *
 * Two (then three) identities exchange shelf-doc state the way y-webrtc
 * would (encodeStateAsUpdate/applyUpdate between plain Y.Docs — no
 * network). Covers: key wrap/unwrap, manifest signing + tamper failure,
 * publish → friend decrypts, stranger decrypts NOTHING (explicit failure),
 * re-key after revocation (stale key and missing envelope both fail),
 * and the visibility field round-trip in the recipe store.
 */
import 'fake-indexeddb/auto'
import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import { identityFromSeed, type Identity } from '../identity/identity'
import {
  decryptRecipePayload,
  dropRecipeKey,
  ensureRecipeKey,
  getRecipeKey,
  processChannel,
  publishShare,
  readEnvelope,
  readManifest,
  readPayload,
  rotateRecipeKey,
  unwrapKey,
  verifyManifest,
} from '../friends/shelf'
import {
  getFriend,
  listFriends,
  parseFriendInvite,
  removeFriend,
  saveFriend,
  type FriendRecord,
} from '../friends/friends'
import { createRepo } from '../store/repo'
import {
  createRecipe,
  getOrCreateIndex,
  getRecipe,
  memoryStore,
  updateRecipe,
} from '../store/recipes'
import type { Recipe } from '../types'

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

describe('friend records + invites', () => {
  it('saves, lists, and removes friends', () => {
    const kv = memoryStore()
    const rec: FriendRecord = {
      did: 'did:key:z6MkFriend',
      name: 'Fay',
      pairSecret: 'AAAA',
      pairId: 'ab'.repeat(32),
      signaling: 'wss://example:4444',
      addedAt: '2026-10-12T00:00:00.000Z',
    }
    saveFriend(rec, kv)
    expect(listFriends(kv)).toHaveLength(1)
    expect(getFriend(rec.did, kv)?.name).toBe('Fay')
    removeFriend(rec.did, kv)
    expect(listFriends(kv)).toHaveLength(0)
  })

  it('rejects malformed invites', () => {
    expect(() => parseFriendInvite('not json')).toThrow()
    expect(() => parseFriendInvite('{"v":1}')).toThrow()
    expect(() =>
      parseFriendInvite(
        JSON.stringify({ v: 2, kind: 'friend', did: 'did:plc:nope' }),
      ),
    ).toThrow()
  })
})

describe('shelf sharing', () => {
  it('friend decrypts; stranger with the same bytes decrypts nothing', async () => {
    const owner = await identityFromSeed(seed(11))
    const friend = await identityFromSeed(seed(22))
    const stranger = await identityFromSeed(seed(33))
    const kv = memoryStore()

    const ownerDoc = new Y.Doc()
    const keyRec = await ensureRecipeKey(RECIPE_ID, kv)
    await publishShare(ownerDoc, owner, 'Olga', RECIPE, RECIPE_ID, keyRec, friend.did)

    // Friend's replica of the shelf, synced from the owner's bytes.
    const friendDoc = new Y.Doc()
    syncDocs(ownerDoc, friendDoc)
    const asFriend = await processChannel(friendDoc, friend)
    expect(asFriend.failures).toEqual([])
    expect(asFriend.received).toHaveLength(1)
    expect(asFriend.received[0].recipe.title).toBe('Secret Soup')
    expect(asFriend.received[0].recipe.ingredients).toEqual(RECIPE.ingredients)

    // Stranger gets the very same doc bytes ("captured traffic").
    const strangerDoc = new Y.Doc()
    syncDocs(ownerDoc, strangerDoc)
    const asStranger = await processChannel(strangerDoc, stranger)
    expect(asStranger.received).toEqual([])
    expect(asStranger.failures.length).toBeGreaterThan(0)
    expect(asStranger.failures[0].reason).toMatch(/no key envelope/)

    // And the raw envelope itself refuses the stranger's key directly.
    const envelope = readEnvelope(strangerDoc, RECIPE_ID, friend.did)
    expect(envelope).not.toBeNull()
    await expect(unwrapKey(stranger, envelope!.sealedKey)).rejects.toThrow()
    // But opens cleanly for the friend it was sealed to.
    await expect(unwrapKey(friend, envelope!.sealedKey)).resolves.toBe(keyRec.key)
  })

  it('manifest tampering fails signature verification', async () => {
    const owner = await identityFromSeed(seed(11))
    const friend = await identityFromSeed(seed(22))
    const kv = memoryStore()
    const doc = new Y.Doc()
    const keyRec = await ensureRecipeKey(RECIPE_ID, kv)
    await publishShare(doc, owner, 'Olga', RECIPE, RECIPE_ID, keyRec, friend.did)

    const manifest = readManifest(doc, owner.did)
    expect(manifest).not.toBeNull()
    expect(await verifyManifest(manifest!)).toBe(true)

    // Attacker rewrites the manifest (name + a share they invented).
    const forged = { ...manifest!, name: 'Mallory' }
    doc.transact(() => {
      doc.getMap('shelf').set(`manifest:${owner.did}`, JSON.stringify(forged))
    })
    expect(await verifyManifest(readManifest(doc, owner.did)!)).toBe(false)
    const res = await processChannel(doc, friend)
    expect(res.received).toEqual([])
    expect(res.failures[0].reason).toMatch(/signature/)
  })

  it('re-key: revoked friend cannot read new versions; remaining friend can', async () => {
    const owner = await identityFromSeed(seed(11))
    const fay = await identityFromSeed(seed(22)) // will be revoked
    const gus = await identityFromSeed(seed(44)) // stays authorized
    const kv = memoryStore()

    // v1 shared to Fay via her channel.
    const fayDoc = new Y.Doc()
    const keyV1 = await ensureRecipeKey(RECIPE_ID, kv)
    await publishShare(fayDoc, owner, 'Olga', RECIPE, RECIPE_ID, keyV1, fay.did)
    const fayReplica = new Y.Doc()
    syncDocs(fayDoc, fayReplica)
    expect((await processChannel(fayReplica, fay)).received).toHaveLength(1)

    // Owner edits the recipe and re-keys with only Gus authorized.
    const v2: Recipe = { ...RECIPE, title: 'Secret Soup v2', updatedAt: '2026-10-12T01:00:00.000Z' }
    const keyV2 = await rotateRecipeKey(RECIPE_ID, [gus.did], kv)
    expect(keyV2.version).toBe(2)
    expect(keyV2.key).not.toBe(keyV1.key)

    // New "traffic": v2 payload published for Gus (in Gus's channel).
    const gusDoc = new Y.Doc()
    await publishShare(gusDoc, owner, 'Olga', v2, RECIPE_ID, keyV2, gus.did)

    // Fay captures Gus's channel bytes — she cannot read v2.
    const fayCapture = new Y.Doc()
    syncDocs(gusDoc, fayCapture)
    const fayAttempt = await processChannel(fayCapture, fay)
    expect(fayAttempt.received).toEqual([])
    expect(fayAttempt.failures[0].reason).toMatch(/no key envelope/)

    // Fay's stale v1 key cannot decrypt the v2 ciphertext directly either.
    const payloadV2 = readPayload(gusDoc, RECIPE_ID)
    expect(payloadV2).not.toBeNull()
    await expect(
      decryptRecipePayload(keyV1.key, payloadV2!.ciphertext),
    ).rejects.toThrow()

    // Gus reads v2 fine.
    const gusReplica = new Y.Doc()
    syncDocs(gusDoc, gusReplica)
    const gusResult = await processChannel(gusReplica, gus)
    expect(gusResult.failures).toEqual([])
    expect(gusResult.received).toHaveLength(1)
    expect(gusResult.received[0].recipe.title).toBe('Secret Soup v2')
  })

  it('vault: ensure/rotate/drop lifecycle persists', async () => {
    const kv = memoryStore()
    const v1 = await ensureRecipeKey('r-x', kv)
    expect(v1.version).toBe(1)
    expect((await ensureRecipeKey('r-x', kv)).keyId).toBe(v1.keyId)
    const v2 = await rotateRecipeKey('r-x', ['did:key:z6MkA'], kv)
    expect(v2.version).toBe(2)
    expect(getRecipeKey('r-x', kv)?.friends).toEqual(['did:key:z6MkA'])
    dropRecipeKey('r-x', kv)
    expect(getRecipeKey('r-x', kv)).toBeUndefined()
  })
})

describe('recipe visibility field', () => {
  it('round-trips through the store and defaults to private', async () => {
    const repo = createRepo('longtable-vis-test')
    const kv = memoryStore()
    const index = await getOrCreateIndex(repo, kv)
    const summary = await createRecipe(repo, index, {
      title: 'Visible',
      ingredients: [],
      steps: [],
      photos: [],
      visibility: 'friends-only',
    })
    const loaded = await getRecipe(repo, summary.url)
    expect(loaded?.visibility).toBe('friends-only')

    await updateRecipe(repo, index, summary.id, { visibility: 'private' })
    const back = await getRecipe(repo, summary.url)
    expect(back?.visibility).toBeUndefined()

    const plain = await createRecipe(repo, index, {
      title: 'Plain',
      ingredients: [],
      steps: [],
      photos: [],
    })
    expect((await getRecipe(repo, plain.url))?.visibility).toBeUndefined()
  })
})

export type { Identity }
