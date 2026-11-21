/**
 * Native backup/restore routing proof — Wave 4 merge fixup (Wave 4A open item 2).
 *
 * On native, the crown-jewel stores live in the Android Keystore behind
 * `secretKv` (sync in-memory mirror + async Keystore persist queue), and
 * the next launch's migration is Keystore-authoritative: a Keystore value
 * always wins over a localStorage copy, which can only be stale. The
 * BackupPanel used to pass raw `localStorage` to collectBackup /
 * restoreBackup, so on a migrated native device:
 *   - creating a backup collected EMPTY friends/vault/shares (those keys
 *     no longer live in localStorage), and
 *   - a restore wrote good values to localStorage while the Keystore
 *     still held the damaged bytes — the mirror kept answering with the
 *     damage in-process, and the next launch's migration cleared the
 *     restored localStorage copies in favour of the damaged Keystore
 *     values. The restore was undone by the reload it tells the user
 *     to do.
 * The panel now passes `secretKv` and awaits `flushSecrets()` after the
 * restore write phase, so the restored values land in the Keystore
 * before any reload.
 *
 * These tests prove the mechanism with the fake Keystore backend
 * (same seam as corrupt.test.ts / secrets.test.ts): a "relaunch" is a
 * fresh secret-store handle over the SAME backend + local store, then
 * initSecrets() — exactly the migration a real relaunch runs.
 * All fixtures are synthetic (deterministic seeds, fixed byte
 * patterns); no real secret ever appears here, and no secret value is
 * ever printed — assertions compare lengths/booleans/equality only.
 * Each encrypted round-trip costs one Argon2id MODERATE derivation
 * (~0.5 s); this file does two.
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
  channelTagFor,
  listFriends,
  pairIdFor,
  saveFriend,
  type FriendRecord,
} from '../friends/friends'
import {
  VAULT_KEY,
  ensureRecipeKey,
  loadVault,
  setKeyFriends,
} from '../friends/shelf'
import { loadReceivedMap, saveReceivedMap, setDisplayName } from '../friends/service'
import { createRepo } from '../store/repo'
import { createRecipe, getOrCreateIndex, type KeyValueStore } from '../store/recipes'
import { collectBackup, createEncryptedBackup, restoreBackup } from '../backup/backup'
import { SHARES_KEY, listShares, roomForRecipe, saveShares } from '../p2p/share'
import { resetCorruptRegistryForTests } from '../store/corrupt'
import {
  flushSecrets,
  initSecrets,
  memoryLocalStore,
  resetSecretStoreForTests,
  secretKv,
  type SecretBackend,
} from '../secrets/secretStore'
import type { RecipeInput } from '../types'

const seed = (n: number) => new Uint8Array(32).fill(n)
/** Synthetic test passphrase (a fixture, never a real secret). */
const PASS = 'correct horse battery staple backup'
const FIXED_TS = '2026-11-21T10:00:00.000Z'

/** Minimal fake Keystore backend (same shape as corrupt.test.ts). */
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

interface NativeDevice {
  backend: FakeBackend
  local: ReturnType<typeof memoryLocalStore>
  repo: ReturnType<typeof createRepo>
  meDid: string
  friendDid: string
  recipeId: string
  identityB64: string
}

let repoCounter = 0

/** A fresh "native device": fake Keystore available, migrated (init ran). */
async function makeDevice(): Promise<NativeDevice> {
  const backend = new FakeBackend()
  const local = memoryLocalStore()
  resetSecretStoreForTests(backend, local)
  await initSecrets()
  const repo = createRepo(`longtable-native-restore-test-${++repoCounter}`)
  return { backend, local, repo, meDid: '', friendDid: '', recipeId: '', identityB64: '' }
}

/** A relaunch: fresh handle + empty mirror over the SAME persisted stores. */
async function relaunch(device: NativeDevice): Promise<void> {
  resetCorruptRegistryForTests()
  resetSecretStoreForTests(device.backend, device.local)
  await initSecrets()
}

const sample = (title: string): RecipeInput => ({
  title,
  ingredients: ['2 cups flour', '1 tsp salt'],
  steps: ['Mix everything.', 'Bake 20 min.'],
  prepMinutes: 10,
  cookMinutes: 20,
  photos: [],
})

/** Populate the device THROUGH secretKv, as the app does on native. */
async function populate(device: NativeDevice): Promise<NativeDevice> {
  const me = await identityFromSeed(seed(1))
  device.identityB64 = u8ToBase64(me.secretKey)
  await restoreIdentitySecret(device.identityB64, secretKv)
  device.meDid = (await getOrCreateIdentity(secretKv)).did
  expect(device.meDid).toBe(me.did)
  setDisplayName('Test Cook', secretKv)

  const friendIdentity = await identityFromSeed(seed(2))
  const pairSecretB64 = u8ToBase64(new Uint8Array(32).fill(7))
  const pairId = await pairIdFor(pairSecretB64)
  const friend: FriendRecord = {
    did: friendIdentity.did,
    name: 'Test Friend',
    pairSecret: pairSecretB64,
    pairId,
    channelTag: channelTagFor(pairId, device.meDid, friendIdentity.did),
    signaling: 'wss://example.invalid/signaling',
    addedAt: FIXED_TS,
  }
  device.friendDid = friend.did
  saveFriend(friend, secretKv)

  const index = await getOrCreateIndex(device.repo, secretKv)
  const r1 = await createRecipe(device.repo, index, sample('Shared Soup'), {
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
  })
  device.recipeId = r1.id
  await ensureRecipeKey(r1.id, secretKv)
  setKeyFriends(r1.id, [friend.did], secretKv)
  saveShares(secretKv, [
    {
      recipeId: r1.id,
      room: roomForRecipe(r1.id),
      signaling: 'wss://example.invalid/signaling',
      role: 'host',
    },
  ])
  saveReceivedMap(secretKv, {
    [`${friend.did}:${r1.id}`]: { localId: r1.id, updatedAt: FIXED_TS },
  })
  await flushSecrets()
  return device
}

/** Corrupt the Keystore copies of every crown-jewel store, as damage would. */
function damageKeystore(device: NativeDevice): void {
  device.backend.map.set(IDENTITY_SECRET_KEY, '{bad')
  device.backend.map.set(FRIENDS_KEY, '{not json')
  device.backend.map.set(VAULT_KEY, '{not json')
  device.backend.map.set(SHARES_KEY, '{not json')
}

beforeEach(() => {
  resetCorruptRegistryForTests()
})

afterEach(() => {
  // Leave the secret-store singleton on a fresh fake so no test's
  // backend leaks (same precedent as corrupt.test.ts).
  resetSecretStoreForTests(new FakeBackend(), memoryLocalStore())
})

describe('native backup routing (Wave 4A open item 2)', () => {
  it('collectBackup through secretKv reads the Keystore-backed friends/vault/shares', async () => {
    const device = await populate(await makeDevice())
    // The values live in the Keystore, not localStorage (migration cleared it).
    expect(device.backend.map.get(IDENTITY_SECRET_KEY)).toBe(device.identityB64)
    expect(device.backend.map.get(FRIENDS_KEY)).toContain(device.friendDid)
    expect(device.local.getItem(FRIENDS_KEY)).toBeNull()
    expect(device.local.getItem(SHARES_KEY)).toBeNull()

    const plain = await collectBackup(
      device.repo,
      secretKv,
      await getOrCreateIdentity(secretKv),
    )
    expect(plain.identity.did).toBe(device.meDid)
    expect(plain.friends).toHaveLength(1)
    expect(plain.friends[0].did).toBe(device.friendDid)
    expect(Object.keys(plain.vault)).toHaveLength(1)
    expect(plain.shares).toHaveLength(1)
    expect(plain.shares[0].recipeId).toBe(device.recipeId)
    expect(Object.keys(plain.received)).toHaveLength(1)
    expect(plain.recipes).toHaveLength(1)
  })

  it('restore through secretKv + flush survives a relaunch after Keystore damage', async () => {
    const device = await populate(await makeDevice())
    const fileText = await createEncryptedBackup(
      await collectBackup(device.repo, secretKv, await getOrCreateIdentity(secretKv)),
      PASS,
    )

    damageKeystore(device)
    await relaunch(device)
    // The damage is live: identity blocks, friends/vault/shares read empty.
    await expect(getOrCreateIdentity(secretKv)).rejects.toThrow(IdentityDamagedError)
    expect(listFriends(secretKv)).toEqual([])
    expect(loadVault(secretKv)).toEqual({})
    expect(listShares(secretKv)).toEqual([])

    // The fixed restore path: secretKv + flush, as BackupPanel now does.
    const report = await restoreBackup(device.repo, secretKv, fileText, PASS)
    await flushSecrets()
    expect(report.recipes).toBe(1)
    expect(report.friends).toBe(1)
    // The restored values are IN the Keystore before any reload.
    expect(device.backend.map.get(IDENTITY_SECRET_KEY)).toBe(device.identityB64)
    expect(JSON.parse(device.backend.map.get(FRIENDS_KEY)!)).toHaveLength(1)
    expect(Object.keys(JSON.parse(device.backend.map.get(VAULT_KEY)!))).toHaveLength(1)
    expect(JSON.parse(device.backend.map.get(SHARES_KEY)!)).toHaveLength(1)

    await relaunch(device)
    expect((await getOrCreateIdentity(secretKv)).did).toBe(device.meDid)
    expect(listFriends(secretKv)).toHaveLength(1)
    expect(listFriends(secretKv)[0].did).toBe(device.friendDid)
    expect(Object.keys(loadVault(secretKv))).toHaveLength(1)
    expect(listShares(secretKv)).toHaveLength(1)
    expect(Object.keys(loadReceivedMap(secretKv))).toHaveLength(1)
  })

  it('restore through raw localStorage does NOT survive a relaunch (control)', async () => {
    const device = await populate(await makeDevice())
    const fileText = await createEncryptedBackup(
      await collectBackup(device.repo, secretKv, await getOrCreateIdentity(secretKv)),
      PASS,
    )

    damageKeystore(device)
    await relaunch(device)
    await expect(getOrCreateIdentity(secretKv)).rejects.toThrow(IdentityDamagedError)

    // The pre-fix path: BackupPanel's old raw-localStorage kv.
    const localKv: KeyValueStore = device.local
    const report = await restoreBackup(device.repo, localKv, fileText, PASS)
    expect(report.recipes).toBe(1)
    // In-process the localStorage copy looks restored — but the mirror
    // still answers with the damage, and nothing reached the Keystore.
    expect(device.backend.map.get(IDENTITY_SECRET_KEY)).toBe('{bad')
    expect(device.local.getItem(IDENTITY_SECRET_KEY)).toBe(device.identityB64)

    await relaunch(device)
    // The migration is Keystore-authoritative: it takes the damaged
    // Keystore value and clears the restored localStorage copy.
    await expect(getOrCreateIdentity(secretKv)).rejects.toThrow(IdentityDamagedError)
    expect(device.local.getItem(IDENTITY_SECRET_KEY)).toBeNull()
    expect(listFriends(secretKv)).toEqual([])
  })
})
