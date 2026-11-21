/**
 * Corrupt-data proof tests — Wave 4A (H8/H9).
 *
 * Proves the two properties the review demands, per store:
 *   (a) corrupt input is quarantined with its bytes preserved and is
 *       NEVER overwritten by any save path, and
 *   (b) a damaged identity blocks regeneration and offers restore.
 *
 * All fixtures are synthetic (deterministic seeds, fixed byte
 * patterns); no real secret ever appears here, and no secret value is
 * ever printed — assertions compare lengths/booleans/equality only.
 * The one Argon2id round-trip (restore-heals test) costs ~1 s.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  IDENTITY_SECRET_KEY,
  IdentityDamagedError,
  getOrCreateIdentity,
  identityFromSeed,
  restoreIdentitySecret,
} from '../identity/identity'
import { u8ToBase64 } from '../identity/codec'
import {
  FRIENDS_KEY,
  listFriends,
  pairIdFor,
  removeFriend,
  saveFriend,
  saveFriendsList,
  type FriendRecord,
} from '../friends/friends'
import {
  VAULT_KEY,
  ensureRecipeKey,
  loadVault,
  saveVault,
} from '../friends/shelf'
import {
  RECEIVED_KEY,
  importReceivedShares,
  loadReceivedMap,
  saveReceivedMap,
} from '../friends/service'
import {
  SHARES_KEY,
  getShare,
  listShares,
  saveShares,
  type ShareRecord,
} from '../p2p/share'
import { DEFAULT_HUB, HUBS_KEY, addHub, getActiveHub, listHubs } from '../hubs/hubs'
import {
  PUBLICATIONS_KEY,
  loadPublications,
  publishRecipe,
  type PublishableRecipe,
} from '../public/publish'
import type { AtprotoClient, AtprotoSession } from '../public/atproto'
import {
  LOCAL_API_SETTINGS_KEY,
  defaultLocalApiSettings,
  loadLocalApiSettings,
  saveLocalApiSettings,
} from '../localapi/settings'
import { createLocalApiHost } from '../localapi/host'
import {
  CorruptStoreError,
  clearCorruptStore,
  discardCorruptStore,
  isStoreCorrupt,
  listCorruptStores,
  quarantineKeyFor,
  resetCorruptRegistryForTests,
} from '../store/corrupt'
import {
  BackupError,
  collectBackup,
  createEncryptedBackup,
  restoreBackup,
} from '../backup/backup'
import {
  flushSecrets,
  initSecrets,
  memoryLocalStore,
  resetSecretStoreForTests,
  type SecretBackend,
} from '../secrets/secretStore'
import { createRepo } from '../store/repo'
import {
  createRecipe,
  getOrCreateIndex,
  memoryStore,
  type KeyValueStore,
} from '../store/recipes'

const seed = (n: number) => new Uint8Array(32).fill(n)
/** Synthetic test passphrase (a fixture, never a real secret). */
const PASS = 'correct horse battery staple backup'

/** In-memory kv with removeItem (recipes.memoryStore has none). */
function memKv(
  seedValues: Record<string, string> = {},
): KeyValueStore & { map: Map<string, string>; removeItem(k: string): void } {
  const map = new Map(Object.entries(seedValues))
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v)
    },
    removeItem: (k) => {
      map.delete(k)
    },
  }
}

const FRIEND_DID = 'did:key:z6MkvDqGT54cXesYGvABpF1UapVNwjCqRcafi4Px6Thv5T3Z'

async function sampleFriend(): Promise<FriendRecord> {
  const pairSecret = u8ToBase64(new Uint8Array(32).fill(9))
  return {
    did: FRIEND_DID,
    name: 'Test Friend',
    pairSecret,
    pairId: await pairIdFor(pairSecret),
    signaling: 'wss://hub.example:4444',
    addedAt: '2026-11-21T00:00:00.000Z',
  }
}

const GOOD_HUB = {
  id: 'hub-b',
  name: 'Hub B',
  signalingUrl: 'wss://hub-b.example:4444',
  appviewUrl: 'https://hub-b.example:3211',
  pdsUrl: 'https://hub-b.example:2584',
}

/** Minimal fake Keystore backend (same shape as secrets.test.ts). */
class FakeBackend implements SecretBackend {
  map = new Map<string, string>()
  available = true
  async isAvailable(): Promise<boolean> {
    return this.available
  }
  async get(key: string): Promise<string | null> {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  async set(key: string, value: string): Promise<void> {
    this.map.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key)
  }
  async keys(): Promise<string[]> {
    return [...this.map.keys()]
  }
}

beforeEach(() => {
  resetCorruptRegistryForTests()
})

afterEach(() => {
  // Leave the secret-store singleton on a fresh fake so no test's
  // backend leaks (same precedent as secrets.test.ts).
  resetSecretStoreForTests(new FakeBackend(), memoryLocalStore())
})

describe('corrupt-store plumbing', () => {
  it('quarantines corrupt bytes under a deterministic key, once', () => {
    const kv = memKv({ [FRIENDS_KEY]: '{not json' })
    expect(listFriends(kv)).toEqual([])
    const qkey = quarantineKeyFor(FRIENDS_KEY, '{not json')
    expect(kv.map.get(qkey)).toBe('{not json')
    expect(kv.map.get(FRIENDS_KEY)).toBe('{not json')
    expect(isStoreCorrupt(FRIENDS_KEY)).toBe(true)
    expect(listCorruptStores()).toHaveLength(1)
    expect(listCorruptStores()[0].quarantineKey).toBe(qkey)
    // Re-detecting the same bytes reuses the same quarantine key.
    expect(listFriends(kv)).toEqual([])
    expect([...kv.map.keys()].filter((k) => k.startsWith(`${FRIENDS_KEY}.corrupt-`))).toEqual([
      qkey,
    ])
  })

  it('absent and valid values record no corruption', () => {
    const kv = memKv()
    expect(listFriends(kv)).toEqual([])
    expect(isStoreCorrupt(FRIENDS_KEY)).toBe(false)
    const friend = { did: FRIEND_DID, pairSecret: 'c2VjcmV0', pairId: 'abcd' }
    kv.setItem(FRIENDS_KEY, JSON.stringify([friend]))
    expect(listFriends(kv)).toHaveLength(1)
    expect(isStoreCorrupt(FRIENDS_KEY)).toBe(false)
    expect(listCorruptStores()).toEqual([])
  })

  it('discard removes the live value, keeps the quarantine copy, heals the store', async () => {
    const kv = memKv({ [FRIENDS_KEY]: '{not json' })
    expect(listFriends(kv)).toEqual([])
    const qkey = quarantineKeyFor(FRIENDS_KEY, '{not json')
    discardCorruptStore(kv, FRIENDS_KEY)
    expect(kv.map.has(FRIENDS_KEY)).toBe(false)
    expect(kv.map.get(qkey)).toBe('{not json')
    expect(isStoreCorrupt(FRIENDS_KEY)).toBe(false)
    expect(listFriends(kv)).toEqual([])
    // The store is writable again after discard.
    await sampleFriend().then((f) => saveFriend(f, kv))
    expect(listFriends(kv)).toHaveLength(1)
  })
})

describe('H8 — damaged identity', () => {
  it('undecodable secret throws, quarantines, and never regenerates', async () => {
    const kv = memKv({ [IDENTITY_SECRET_KEY]: '!!!not-base64!!!' })
    await expect(getOrCreateIdentity(kv)).rejects.toThrow(IdentityDamagedError)
    // The corrupt bytes are untouched, and no fresh secret was minted.
    expect(kv.map.get(IDENTITY_SECRET_KEY)).toBe('!!!not-base64!!!')
    expect(kv.map.get(quarantineKeyFor(IDENTITY_SECRET_KEY, '!!!not-base64!!!'))).toBe(
      '!!!not-base64!!!',
    )
    // A second call throws again — it does not silently mint a DID.
    await expect(getOrCreateIdentity(kv)).rejects.toThrow(IdentityDamagedError)
    expect(kv.map.get(IDENTITY_SECRET_KEY)).toBe('!!!not-base64!!!')
  })

  it('wrong-length secret throws instead of regenerating', async () => {
    const short = u8ToBase64(new Uint8Array(32).fill(1)) // 32 bytes, not 64
    const kv = memKv({ [IDENTITY_SECRET_KEY]: short })
    let caught: unknown
    try {
      await getOrCreateIdentity(kv)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(IdentityDamagedError)
    expect((caught as IdentityDamagedError).reason).toContain('32 bytes')
    expect(kv.map.get(IDENTITY_SECRET_KEY)).toBe(short)
  })

  it('absent secret still generates on first launch; valid secret still loads', async () => {
    const kv = memKv()
    const a = await getOrCreateIdentity(kv)
    const b = await getOrCreateIdentity(kv)
    expect(b.did).toBe(a.did)
    expect(isStoreCorrupt(IDENTITY_SECRET_KEY)).toBe(false)
  })

  it('restore heals the damage: the restored DID loads afterwards', async () => {
    const kv = memKv({ [IDENTITY_SECRET_KEY]: '{bad' })
    await expect(getOrCreateIdentity(kv)).rejects.toThrow(IdentityDamagedError)
    const good = await identityFromSeed(seed(5))
    const did = await restoreIdentitySecret(u8ToBase64(good.secretKey), kv)
    expect(did).toBe(good.did)
    expect(isStoreCorrupt(IDENTITY_SECRET_KEY)).toBe(false)
    expect((await getOrCreateIdentity(kv)).did).toBe(good.did)
  })

  it('the localhost API read path throws instead of rotating the DID', async () => {
    const kv = memKv({ [IDENTITY_SECRET_KEY]: '!!!not-base64!!!' })
    const host = createLocalApiHost({ kv })
    await expect(host.getIdentityDid()).rejects.toThrow(IdentityDamagedError)
    expect(kv.map.get(IDENTITY_SECRET_KEY)).toBe('!!!not-base64!!!')
  })

  it('restoreIdentitySecret defaults to the secure store, not localStorage', async () => {
    const backend = new FakeBackend()
    const local = memoryLocalStore()
    resetSecretStoreForTests(backend, local)
    await initSecrets()
    const good = await identityFromSeed(seed(6))
    await restoreIdentitySecret(u8ToBase64(good.secretKey))
    await flushSecrets()
    expect(backend.map.get(IDENTITY_SECRET_KEY)).toBe(u8ToBase64(good.secretKey))
    expect(local.getItem(IDENTITY_SECRET_KEY)).toBeNull()
  })
})

describe('H9 — friends list', () => {
  it('corrupt JSON reads empty, quarantines, and no save overwrites it', async () => {
    const kv = memKv({ [FRIENDS_KEY]: '{not json' })
    expect(listFriends(kv)).toEqual([])
    expect(isStoreCorrupt(FRIENDS_KEY)).toBe(true)
    const friend = await sampleFriend()
    expect(() => saveFriend(friend, kv)).toThrow(CorruptStoreError)
    expect(() => removeFriend(FRIEND_DID, kv)).toThrow(CorruptStoreError)
    expect(kv.map.get(FRIENDS_KEY)).toBe('{not json')
    expect(kv.map.get(quarantineKeyFor(FRIENDS_KEY, '{not json'))).toBe('{not json')
  })

  it('a non-array top level is corrupt; one bad entry drops alone', async () => {
    const kv = memKv({ [FRIENDS_KEY]: JSON.stringify({ nope: true }) })
    expect(listFriends(kv)).toEqual([])
    expect(isStoreCorrupt(FRIENDS_KEY)).toBe(true)
    const good = await sampleFriend()
    const kv2 = memKv({
      [FRIENDS_KEY]: JSON.stringify([good, { did: 42 }, null]),
    })
    expect(listFriends(kv2)).toEqual([good])
    expect(isStoreCorrupt(FRIENDS_KEY)).toBe(false)
  })

  it('restore clearing the record lets the whole-list write replace it', async () => {
    const kv = memKv({ [FRIENDS_KEY]: '{not json' })
    expect(listFriends(kv)).toEqual([])
    const friend = await sampleFriend()
    // Clearing alone does NOT make saveFriend work: it re-loads first,
    // and the still-damaged bytes re-register the corruption (correct —
    // the registry reflects the bytes). Restore therefore writes the
    // whole list in one call after clearing (saveFriendsList).
    clearCorruptStore(FRIENDS_KEY) // what restoreBackup does before writing
    expect(() => saveFriend(friend, kv)).toThrow(CorruptStoreError)
    clearCorruptStore(FRIENDS_KEY)
    saveFriendsList([friend], kv)
    expect(listFriends(kv)).toHaveLength(1)
    expect(isStoreCorrupt(FRIENDS_KEY)).toBe(false)
  })
})

describe('H9 — key vault', () => {
  it('corrupt JSON reads empty and no vault write overwrites it', async () => {
    const kv = memKv({ [VAULT_KEY]: '{not json' })
    expect(loadVault(kv)).toEqual({})
    expect(() => saveVault({ r1: { keyId: 'k', key: 'a2V5', version: 1, friends: [] } }, kv)).toThrow(
      CorruptStoreError,
    )
    await expect(ensureRecipeKey('r1', kv)).rejects.toThrow(CorruptStoreError)
    expect(kv.map.get(VAULT_KEY)).toBe('{not json')
  })

  it('one bad entry drops alone; good entries survive', () => {
    const good = { keyId: 'k1', key: 'a2V5', version: 1, friends: [] }
    const kv = memKv({
      [VAULT_KEY]: JSON.stringify({ r1: good, r2: { keyId: 'k2' }, r3: 'nope' }),
    })
    expect(loadVault(kv)).toEqual({ r1: good })
    expect(isStoreCorrupt(VAULT_KEY)).toBe(false)
  })
})

describe('H9 — P2P shares', () => {
  it('corrupt JSON reads empty and no save overwrites it', () => {
    const kv = memKv({ [SHARES_KEY]: '{not json' })
    expect(listShares(kv)).toEqual([])
    const rec: ShareRecord = {
      recipeId: 'r1',
      room: 'longtable-share-r1',
      signaling: 'wss://hub.example:4444',
      role: 'host',
    }
    expect(() => saveShares(kv, [rec])).toThrow(CorruptStoreError)
    expect(kv.map.get(SHARES_KEY)).toBe('{not json')
  })

  it('one bad record drops alone; good records survive', () => {
    const good: ShareRecord = {
      recipeId: 'r1',
      room: 'longtable-share-r1',
      signaling: 'wss://hub.example:4444',
      role: 'host',
    }
    const kv = memKv({
      [SHARES_KEY]: JSON.stringify([good, { recipeId: 'r2' }, 'nope']),
    })
    expect(listShares(kv)).toEqual([good])
    expect(isStoreCorrupt(SHARES_KEY)).toBe(false)
  })

  it('quarantine copies of a secret store land in the Keystore, not localStorage', async () => {
    const backend = new FakeBackend()
    const local = memoryLocalStore()
    backend.map.set(SHARES_KEY, '{not json')
    resetSecretStoreForTests(backend, local)
    await initSecrets()
    expect(getShare('r1')).toBeUndefined()
    const qkey = quarantineKeyFor(SHARES_KEY, '{not json')
    await flushSecrets()
    expect(backend.map.get(qkey)).toBe('{not json')
    expect(backend.map.get(SHARES_KEY)).toBe('{not json')
    expect(local.getItem(qkey)).toBeNull()
    expect(local.getItem(SHARES_KEY)).toBeNull()
  })
})

describe('H9 — received-shares mapping', () => {
  it('corrupt JSON reads empty and no save overwrites it', () => {
    const kv = memKv({ [RECEIVED_KEY]: '{not json' })
    expect(loadReceivedMap(kv)).toEqual({})
    expect(() => saveReceivedMap(kv, { 'did:r1': { localId: 'x', updatedAt: 't' } })).toThrow(
      CorruptStoreError,
    )
    expect(kv.map.get(RECEIVED_KEY)).toBe('{not json')
  })

  it('import skips the save when the mapping is corrupt (bytes preserved)', async () => {
    const kv = memKv({ [RECEIVED_KEY]: '{not json' })
    const repo = createRepo('longtable-corrupt-test-received')
    const me = await identityFromSeed(seed(7))
    const count = await importReceivedShares(me, kv, repo)
    expect(count).toBe(0)
    expect(kv.map.get(RECEIVED_KEY)).toBe('{not json')
    expect(isStoreCorrupt(RECEIVED_KEY)).toBe(true)
  })
})

describe('H9 — hub registry', () => {
  it('corrupt JSON falls back to the default hub and hub writes refuse', () => {
    const kv = memKv({ [HUBS_KEY]: '{not json' })
    expect(getActiveHub(kv).id).toBe(DEFAULT_HUB.id)
    expect(isStoreCorrupt(HUBS_KEY)).toBe(true)
    expect(() => addHub({ ...GOOD_HUB }, kv)).toThrow(CorruptStoreError)
    expect(kv.map.get(HUBS_KEY)).toBe('{not json')
  })

  it('one bad entry drops alone; the good hubs survive (no whole-registry wipe)', () => {
    const kv = memKv({
      [HUBS_KEY]: JSON.stringify({
        hubs: [GOOD_HUB, { id: 42, name: 'Bad' }],
        activeId: 'hub-b',
      }),
    })
    expect(listHubs(kv)).toHaveLength(1)
    expect(listHubs(kv)[0].id).toBe('hub-b')
    expect(isStoreCorrupt(HUBS_KEY)).toBe(false)
  })

  it('an empty hub list is corrupt, not a silent default', () => {
    const kv = memKv({ [HUBS_KEY]: JSON.stringify({ hubs: [], activeId: 'x' }) })
    expect(getActiveHub(kv).id).toBe(DEFAULT_HUB.id)
    expect(isStoreCorrupt(HUBS_KEY)).toBe(true)
  })
})

describe('H9 — publications registry', () => {
  it('corrupt JSON reads empty and bad entries drop alone', () => {
    const kv = memKv({ [PUBLICATIONS_KEY]: '{not json' })
    expect(loadPublications(kv)).toEqual({})
    expect(isStoreCorrupt(PUBLICATIONS_KEY)).toBe(true)
    const good = {
      did: 'did:plc:alice',
      uri: 'at://did:plc:alice/kitchen.longtable.recipe/r1',
      rkey: 'r1',
      cid: 'bafy1',
      pdsUrl: 'http://pds.example',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    const kv2 = memKv({
      [PUBLICATIONS_KEY]: JSON.stringify({ r1: good, r2: { uri: 'x' } }),
    })
    expect(loadPublications(kv2)).toEqual({ r1: good })
    expect(isStoreCorrupt(PUBLICATIONS_KEY)).toBe(false)
  })

  it('publishing still succeeds when the registry is corrupt, and the bytes survive', async () => {
    const kv = memKv({ [PUBLICATIONS_KEY]: '{not json' })
    const identity = await identityFromSeed(seed(8))
    const session: AtprotoSession = {
      did: 'did:plc:alice',
      handle: 'alice.test',
      pdsUrl: 'http://pds.example',
      accessJwt: 'a',
      refreshJwt: 'r',
    }
    const client = {
      pdsUrl: 'http://pds.example',
      getRecord: async () => null,
      putRecord: async (_s: unknown, args: { collection: string; rkey: string }) => ({
        uri: `at://did:plc:alice/${args.collection}/${args.rkey}`,
        cid: 'bafycid',
      }),
    } as unknown as AtprotoClient
    const recipe: PublishableRecipe = {
      id: 'recipe-1',
      title: 'Tomato Soup',
      ingredients: ['tomatoes', 'salt'],
      steps: ['Chop', 'Simmer'],
      photos: [],
      prepMinutes: 5,
      cookMinutes: 25,
      createdAt: '2026-01-01T10:00:00.000Z',
      updatedAt: '2026-01-02T10:00:00.000Z',
    }
    const uri = await publishRecipe(client, session, identity, recipe, kv)
    expect(uri).toContain('kitchen.longtable.recipe/recipe-1')
    // The PDS write succeeded; the corrupt registry was NOT overwritten.
    expect(kv.map.get(PUBLICATIONS_KEY)).toBe('{not json')
    expect(isStoreCorrupt(PUBLICATIONS_KEY)).toBe(true)
  })
})

describe('H9 — local API settings', () => {
  it('corrupt JSON reads as defaults and no save overwrites it', () => {
    const kv = memKv({ [LOCAL_API_SETTINGS_KEY]: '{not json' })
    expect(loadLocalApiSettings(kv)).toEqual(defaultLocalApiSettings())
    expect(isStoreCorrupt(LOCAL_API_SETTINGS_KEY)).toBe(true)
    expect(() =>
      saveLocalApiSettings({ enabled: true, port: 17337, token: 'abc' }, kv),
    ).toThrow(CorruptStoreError)
    expect(kv.map.get(LOCAL_API_SETTINGS_KEY)).toBe('{not json')
  })
})

describe('H8+H9 — backup restore heals', () => {
  let dbCounter = 0

  it('restore replaces a damaged identity and damaged friends store', async () => {
    // Device A (clean): identity + friend + recipe + vault + share.
    const kvA = memoryStore()
    const repoA = createRepo(`longtable-corrupt-test-a-${++dbCounter}`)
    const me = await identityFromSeed(seed(11))
    await restoreIdentitySecret(u8ToBase64(me.secretKey), kvA)
    const friend = await sampleFriend()
    saveFriend(friend, kvA)
    const indexA = await getOrCreateIndex(repoA, kvA)
    const summary = await createRecipe(repoA, indexA, {
      title: 'Healing Soup',
      ingredients: ['water'],
      steps: ['Boil.'],
      photos: [],
    })
    await ensureRecipeKey(summary.id, kvA)
    saveShares(kvA, [
      {
        recipeId: summary.id,
        room: `longtable-share-${summary.id}`,
        signaling: 'wss://hub.example:4444',
        role: 'host',
      },
    ])
    const plain = await collectBackup(repoA, kvA, me)
    const fileText = await createEncryptedBackup(plain, PASS)

    // Device B (damaged): corrupt identity secret + corrupt friends.
    const kvB = memoryStore()
    const repoB = createRepo(`longtable-corrupt-test-b-${dbCounter}`)
    kvB.setItem(IDENTITY_SECRET_KEY, '!!!not-base64!!!')
    kvB.setItem(FRIENDS_KEY, '{not json')
    await expect(getOrCreateIdentity(kvB)).rejects.toThrow(IdentityDamagedError)
    expect(listFriends(kvB)).toEqual([])

    const report = await restoreBackup(repoB, kvB, fileText, PASS)
    expect(report.did).toBe(me.did)
    expect((await getOrCreateIdentity(kvB)).did).toBe(me.did)
    expect(isStoreCorrupt(IDENTITY_SECRET_KEY)).toBe(false)
    expect(isStoreCorrupt(FRIENDS_KEY)).toBe(false)
    expect(listFriends(kvB)).toHaveLength(1)
    expect(listFriends(kvB)[0].did).toBe(friend.did)
    expect(loadVault(kvB)[summary.id]).toBeDefined()
    expect(listShares(kvB)).toHaveLength(1)
  })

  it('collectBackup refuses when a source store is damaged', async () => {
    const kv = memoryStore()
    const repo = createRepo(`longtable-corrupt-test-c-${++dbCounter}`)
    const me = await identityFromSeed(seed(12))
    await restoreIdentitySecret(u8ToBase64(me.secretKey), kv)
    const index = await getOrCreateIndex(repo, kv)
    await createRecipe(repo, index, {
      title: 'Soup',
      ingredients: ['water'],
      steps: ['Boil.'],
      photos: [],
    })
    // Clean state backs up fine.
    await expect(collectBackup(repo, kv, me)).resolves.toBeDefined()
    // A damaged friends store refuses: the backup would snapshot an
    // empty friend list and delete the friends on restore.
    kv.setItem(FRIENDS_KEY, '{not json')
    await expect(collectBackup(repo, kv, me)).rejects.toThrow(BackupError)
  })
})
