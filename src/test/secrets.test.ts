/**
 * Secret storage unit tests: Keystore migration (localStorage -> secure
 * store), the routing store, degraded mode, and the wiring that the
 * secret accessors' default `kv` is the secure store.
 *
 * Values here are synthetic (no live secrets); assertions are on
 * presence/absence/equality, never on secret contents.
 */
import { describe, expect, it, afterEach } from 'vitest'
import {
  MIGRATION_MARKER_KEY,
  SECRET_KEYS,
  createSecretStore,
  flushSecrets,
  memoryLocalStore,
  resetSecretStoreForTests,
  secretKv,
  type LocalStore,
  type SecretBackend,
} from '../secrets/secretStore'
import { getOrCreateIdentity } from '../identity/identity'
import { loadVault, saveVault } from '../friends/shelf'
import { listFriends, saveFriend, type FriendRecord } from '../friends/friends'
import {
  PUBLICATIONS_KEY,
  SESSION_KEY,
  loadSession,
  saveSession,
  clearSession,
  type AtprotoSession,
} from '../public/atproto'
import {
  LOCAL_API_SETTINGS_KEY,
  loadLocalApiSettings,
  saveLocalApiSettings,
} from '../localapi/settings'
import { HUBS_KEY, addHub, listHubs } from '../hubs/hubs'

const IDENTITY_KEY = 'longtable:identity-secret'
const VAULT_KEY = 'longtable:key-vault'
const FRIENDS_KEY = 'longtable:friends'
const SHARES_KEY = 'longtable:shares'

class FakeBackend implements SecretBackend {
  map = new Map<string, string>()
  available = true
  failGet = new Set<string>()
  failSet = new Set<string>()
  corruptGet = new Set<string>()
  async isAvailable(): Promise<boolean> {
    return this.available
  }
  async get(key: string): Promise<string | null> {
    if (this.failGet.has(key)) throw new Error('decrypt failed')
    // Corrupts the read-back of a value that was written (models a
    // stored value that no longer decrypts to what was written), not
    // the initial absent-read — an absent key still reads back null.
    if (this.corruptGet.has(key) && this.map.has(key)) return 'corrupted-value'
    return this.map.has(key) ? this.map.get(key)! : null
  }
  async set(key: string, value: string): Promise<void> {
    if (this.failSet.has(key)) throw new Error('keystore write failed')
    this.map.set(key, value)
  }
  async remove(key: string): Promise<void> {
    this.map.delete(key)
  }
  async keys(): Promise<string[]> {
    return [...this.map.keys()]
  }
}

function freshStore(backend?: FakeBackend, local?: LocalStore) {
  const b = backend ?? new FakeBackend()
  const l = local ?? memoryLocalStore()
  return { backend: b, local: l, store: createSecretStore(b, l) }
}

afterEach(() => {
  // Leave the singleton on a fresh fake so no test's backend leaks.
  resetSecretStoreForTests(new FakeBackend(), memoryLocalStore())
})

describe('SECRET_KEYS', () => {
  it('covers every crown-jewel key and no public registry', () => {
    expect(SECRET_KEYS.has(IDENTITY_KEY)).toBe(true)
    expect(SECRET_KEYS.has(VAULT_KEY)).toBe(true)
    expect(SECRET_KEYS.has(FRIENDS_KEY)).toBe(true)
    expect(SECRET_KEYS.has(SESSION_KEY)).toBe(true)
    expect(SECRET_KEYS.has(LOCAL_API_SETTINGS_KEY)).toBe(true)
    expect(SECRET_KEYS.has(HUBS_KEY)).toBe(true)
    expect(SECRET_KEYS.has(SHARES_KEY)).toBe(true)
    // Publications are URIs/CIDs (public info), not secrets.
    expect(SECRET_KEYS.has(PUBLICATIONS_KEY)).toBe(false)
    expect(SECRET_KEYS.has('longtable:display-name')).toBe(false)
  })
})

describe('routing store', () => {
  it('writes secrets to the backend, never to localStorage', async () => {
    const { backend, local, store } = freshStore()
    store.kv.setItem(IDENTITY_KEY, 'secret-value')
    store.kv.setItem('longtable:display-name', 'Olga')
    await store.flushSecrets()
    expect(backend.map.get(IDENTITY_KEY)).toBe('secret-value')
    expect(local.getItem(IDENTITY_KEY)).toBeNull()
    expect(local.getItem('longtable:display-name')).toBe('Olga')
    expect(store.kv.getItem(IDENTITY_KEY)).toBe('secret-value')
    expect(store.kv.getItem('longtable:display-name')).toBe('Olga')
  })

  it('reads a legacy localStorage value before init runs', async () => {
    const { local, store } = freshStore()
    local.setItem(VAULT_KEY, '{"r1":{"keyId":"k"}}')
    expect(store.kv.getItem(VAULT_KEY)).toBe('{"r1":{"keyId":"k"}}')
  })

  it('removes a secret from the backend after flush', async () => {
    const { backend, store } = freshStore()
    store.kv.setItem(SESSION_KEY, '{"did":"d"}')
    await store.flushSecrets()
    expect(backend.map.has(SESSION_KEY)).toBe(true)
    store.kv.removeItem(SESSION_KEY)
    await store.flushSecrets()
    expect(backend.map.has(SESSION_KEY)).toBe(false)
    expect(store.kv.getItem(SESSION_KEY)).toBeNull()
  })
})

describe('migration', () => {
  it('does not expose a Keystore-held value before initSecrets resolves (pre-init gap)', async () => {
    // Regression contract for the main.tsx ordering: the sync mirror is
    // empty until initSecrets() hydrates it, so a startup reader that
    // runs before init (e.g. rejoinShares racing the init effect) sees
    // nothing for a value already moved to the Keystore. The localStorage
    // fallback only covers values that have NOT been migrated yet.
    const { backend, local, store } = freshStore()
    await store.kv.setItem('longtable:shares', '[{"room":"r1"}]')
    await store.flushSecrets()
    // Fresh store instance, same backend: the value lives in the Keystore.
    const fresh = freshStore(backend, local)
    expect(fresh.store.kv.getItem('longtable:shares')).toBeNull()
    await fresh.store.initSecrets()
    expect(fresh.store.kv.getItem('longtable:shares')).toBe('[{"room":"r1"}]')
  })

  it('migrates a legacy localStorage value into the secure store and clears the legacy copy', async () => {
    const { backend, local, store } = freshStore()
    local.setItem(IDENTITY_KEY, 'legacy-secret')
    local.setItem(FRIENDS_KEY, '[]')
    const report = await store.initSecrets()
    expect(report.secureAvailable).toBe(true)
    expect(report.perKey[IDENTITY_KEY].outcome).toBe('moved')
    expect(report.perKey[IDENTITY_KEY].legacyCleared).toBe(true)
    expect(report.perKey[FRIENDS_KEY].outcome).toBe('moved')
    expect(report.perKey[VAULT_KEY].outcome).toBe('absent')
    expect(report.migratedMarkerSet).toBe(true)
    expect(backend.map.get(IDENTITY_KEY)).toBe('legacy-secret')
    expect(local.getItem(IDENTITY_KEY)).toBeNull()
    expect(local.getItem(MIGRATION_MARKER_KEY)).toBe('1')
    expect(store.kv.getItem(IDENTITY_KEY)).toBe('legacy-secret')
  })

  it('is idempotent: a second launch finds everything already secure', async () => {
    const { backend, local, store } = freshStore()
    local.setItem(IDENTITY_KEY, 'legacy-secret')
    const first = await store.initSecrets()
    expect(first.perKey[IDENTITY_KEY].outcome).toBe('moved')
    // Second launch = a fresh store instance over the same backend/local.
    // (initSecrets() itself memoizes per process, so a re-run must go
    // through a new instance to exercise the already-secure path.)
    const secondStore = createSecretStore(backend, local)
    const second = await secondStore.initSecrets()
    expect(second.perKey[IDENTITY_KEY].outcome).toBe('already-secure')
    expect(backend.map.get(IDENTITY_KEY)).toBe('legacy-secret')
    expect(local.getItem(IDENTITY_KEY)).toBeNull()
  })

  it('Keystore wins over a stale localStorage copy', async () => {
    const { backend, local, store } = freshStore()
    backend.map.set(IDENTITY_KEY, 'newer-in-keystore')
    local.setItem(IDENTITY_KEY, 'stale-in-localstorage')
    const report = await store.initSecrets()
    expect(report.perKey[IDENTITY_KEY].outcome).toBe('already-secure')
    expect(report.perKey[IDENTITY_KEY].legacyCleared).toBe(true)
    expect(store.kv.getItem(IDENTITY_KEY)).toBe('newer-in-keystore')
    expect(backend.map.get(IDENTITY_KEY)).toBe('newer-in-keystore')
    expect(local.getItem(IDENTITY_KEY)).toBeNull()
  })

  it('a write before init wins the migration (early-write branch)', async () => {
    const { backend, local, store } = freshStore()
    local.setItem(IDENTITY_KEY, 'stale-legacy')
    store.kv.setItem(IDENTITY_KEY, 'written-before-init')
    const report = await store.initSecrets()
    expect(report.perKey[IDENTITY_KEY].outcome).toBe('moved-early-write')
    expect(backend.map.get(IDENTITY_KEY)).toBe('written-before-init')
    expect(local.getItem(IDENTITY_KEY)).toBeNull()
  })

  it('a failed secure write keeps the legacy copy and reports failed', async () => {
    const { backend, local, store } = freshStore()
    backend.failSet.add(IDENTITY_KEY)
    local.setItem(IDENTITY_KEY, 'legacy-secret')
    const report = await store.initSecrets()
    expect(report.perKey[IDENTITY_KEY].outcome).toBe('failed')
    expect(report.perKey[IDENTITY_KEY].legacyCleared).toBe(false)
    expect(report.migratedMarkerSet).toBe(false)
    expect(local.getItem(IDENTITY_KEY)).toBe('legacy-secret')
    // Reads still work via the localStorage fallback.
    expect(store.kv.getItem(IDENTITY_KEY)).toBe('legacy-secret')
  })

  it('a read-back mismatch keeps the legacy copy and reports failed', async () => {
    const { backend, local, store } = freshStore()
    backend.corruptGet.add(IDENTITY_KEY)
    local.setItem(IDENTITY_KEY, 'legacy-secret')
    const report = await store.initSecrets()
    expect(report.perKey[IDENTITY_KEY].outcome).toBe('failed')
    expect(local.getItem(IDENTITY_KEY)).toBe('legacy-secret')
  })

  it('an unreadable Keystore entry reports failed, never absent', async () => {
    const { backend, local, store } = freshStore()
    backend.failGet.add(IDENTITY_KEY)
    local.setItem(IDENTITY_KEY, 'legacy-secret')
    const report = await store.initSecrets()
    expect(report.perKey[IDENTITY_KEY].outcome).toBe('failed')
    expect(local.getItem(IDENTITY_KEY)).toBe('legacy-secret')
  })

  it('status reports per-key presence as booleans', async () => {
    const { local, store } = freshStore()
    local.setItem(IDENTITY_KEY, 'legacy-secret')
    await store.initSecrets()
    const status = await store.secretsStatus()
    expect(status.secureAvailable).toBe(true)
    expect(status.initialized).toBe(true)
    expect(status.migrated).toBe(true)
    expect(status.pendingWrites).toBe(0)
    expect(status.lastPersistError).toBeNull()
    expect(status.keys[IDENTITY_KEY]).toEqual({
      inMemory: true,
      inLocalStorage: false,
      inSecureStore: true,
    })
  })
})

describe('degraded mode (Keystore unavailable)', () => {
  it('keeps secrets working from localStorage and migrates later', async () => {
    const backend = new FakeBackend()
    backend.available = false
    const local = memoryLocalStore()
    const store = createSecretStore(backend, local)
    local.setItem(IDENTITY_KEY, 'legacy-secret')
    const report = await store.initSecrets()
    expect(report.secureAvailable).toBe(false)
    expect(report.perKey[IDENTITY_KEY].outcome).toBe('degraded')
    expect(report.migratedMarkerSet).toBe(false)
    expect(local.getItem(IDENTITY_KEY)).toBe('legacy-secret')
    expect(store.kv.getItem(IDENTITY_KEY)).toBe('legacy-secret')
    // A new write in degraded mode still lands in localStorage (durable).
    store.kv.setItem(VAULT_KEY, '{"v":1}')
    await store.flushSecrets()
    expect(local.getItem(VAULT_KEY)).toBe('{"v":1}')
    expect(backend.map.has(VAULT_KEY)).toBe(false)
    // Keystore comes back: the next store instance migrates both keys.
    backend.available = true
    const store2 = createSecretStore(backend, local)
    const report2 = await store2.initSecrets()
    expect(report2.perKey[IDENTITY_KEY].outcome).toBe('moved')
    expect(report2.perKey[VAULT_KEY].outcome).toBe('moved')
    expect(backend.map.get(IDENTITY_KEY)).toBe('legacy-secret')
    expect(local.getItem(IDENTITY_KEY)).toBeNull()
  })
})

describe('secret accessor wiring (default kv is the secure store)', () => {
  it('identity persists with no explicit kv and lands in the backend', async () => {
    const backend = new FakeBackend()
    const local = memoryLocalStore()
    resetSecretStoreForTests(backend, local)
    const a = await getOrCreateIdentity()
    const b = await getOrCreateIdentity()
    expect(b.did).toBe(a.did)
    expect(b.secretKey).toEqual(a.secretKey)
    expect(backend.map.has(IDENTITY_KEY)).toBe(true)
    expect(local.getItem(IDENTITY_KEY)).toBeNull()
    expect(secretKv.getItem(IDENTITY_KEY)).not.toBeNull()
  })

  it('vault, friends, session, local-API settings, hubs default to the backend', async () => {
    const backend = new FakeBackend()
    const local = memoryLocalStore()
    resetSecretStoreForTests(backend, local)
    saveVault({ r1: { keyId: 'k1', key: 'abc', version: 1, friends: [] } })
    expect(loadVault()['r1']?.keyId).toBe('k1')
    const rec: FriendRecord = {
      did: 'did:key:z123',
      name: 'Fay',
      pairSecret: 'c2VjcmV0',
      pairId: 'ab'.repeat(32),
      signaling: 'wss://example.invalid',
      addedAt: new Date().toISOString(),
    }
    saveFriend(rec)
    expect(listFriends()).toHaveLength(1)
    const session: AtprotoSession = {
      did: 'did:plc:test',
      handle: 'alice.test',
      pdsUrl: 'https://pds.example.invalid',
      accessJwt: 'access',
      refreshJwt: 'refresh',
    }
    saveSession(session)
    expect(loadSession()?.handle).toBe('alice.test')
    saveLocalApiSettings({ enabled: true, port: 17337, token: 'tok' })
    expect(loadLocalApiSettings().token).toBe('tok')
    const hub = addHub({
      name: 'Test hub',
      signalingUrl: 'wss://hub.example.invalid',
      turnUrl: 'turn:hub.example.invalid:3478',
      turnUsername: 'u',
      turnCredential: 'c',
      appviewUrl: 'https://appview.example.invalid',
      pdsUrl: 'https://pds.example.invalid',
    })
    expect(listHubs().some((h) => h.id === hub.id)).toBe(true)
    // Flush, then every jewel is in the backend and none in localStorage.
    await flushSecrets()
    for (const key of [
      VAULT_KEY,
      FRIENDS_KEY,
      SESSION_KEY,
      LOCAL_API_SETTINGS_KEY,
      HUBS_KEY,
    ]) {
      expect(backend.map.has(key)).toBe(true)
      expect(local.getItem(key)).toBeNull()
    }
    clearSession()
    await flushSecrets()
    expect(backend.map.has(SESSION_KEY)).toBe(false)
    expect(loadSession()).toBeNull()
  })
})
