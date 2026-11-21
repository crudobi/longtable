/**
 * Secret storage — Android Keystore via the SecureStore Capacitor plugin
 * (Wave 3, security H1).
 *
 * The finding: every crown-jewel secret lived in plaintext localStorage
 * (identity Ed25519 secret, per-recipe key vault, friend pair secrets,
 * ATProto JWTs, loopback API token, TURN credentials, P2P share room
 * secrets). One XSS — or one read of the WebView's storage files —
 * was total permanent compromise. No XSS vector was found in src/, so
 * this was latent; the Keystore move closes the at-rest vector.
 *
 * Design (see docs/keystore-secrets.md for the full decision record):
 *
 *   - Async init + sync in-memory mirror. Keystore access is async,
 *     but the identity/vault/friends/session accessors are sync and
 *     their signatures are frozen (another Wave 3 worker reads secrets
 *     through them). So at startup `initSecrets()` loads the secrets
 *     out of the Keystore into an in-memory map, and `secretKv` — the
 *     default store every secret accessor now uses — answers sync
 *     reads from that map. Writes update the map synchronously and
 *     persist to the Keystore through an ordered async queue
 *     (drainable via `flushSecrets()`).
 *   - Migration is Keystore-authoritative and idempotent. On first
 *     run after upgrade each legacy localStorage value is written to
 *     the Keystore, verified by read-back, and only then cleared from
 *     localStorage. A value already in the Keystore always wins over
 *     a localStorage copy, which can only be stale.
 *   - Degraded mode, never a broken app. When the Keystore is
 *     unavailable (no native plugin on web/PWA, Keystore locked or
 *     corrupt), secrets keep working from localStorage exactly as
 *     before, and the next launch with a working Keystore migrates
 *     them. `initSecrets()` reports this per key.
 *   - Honest boundary: this protects secrets AT REST. Secrets are in
 *     JS memory while the app runs (the sync accessors require it),
 *     so injected script running live in the WebView could still read
 *     the in-memory copies. Keys that never leave the Keystore
 *     (native signing/sealing) is future work; the CSP and the zero
 *     innerHTML sinks remain the live-XSS defenses.
 */
import { SecureStoreNative, secureStoreAvailable } from './secureStorePlugin'
import type { KeyValueStore } from '../store/recipes'

/** A KeyValueStore that can also delete a key (localStorage-shaped). */
export type LocalStore = KeyValueStore & {
  removeItem(key: string): void
}

/** The crown-jewel keys. Non-secret keys route straight to localStorage. */
export const SECRET_KEYS: ReadonlySet<string> = new Set([
  'longtable:identity-secret', // Ed25519 secret key (identity.ts)
  'longtable:key-vault', // per-recipe symmetric keys (friends/shelf.ts)
  'longtable:friends', // friend records incl. pair secrets (friends.ts)
  'longtable:atproto-session', // ATProto JWTs (public/atproto.ts)
  'longtable:localapi', // loopback API settings incl. token (localapi/)
  'longtable:hubs:v1', // hub registry incl. TURN creds (hubs/hubs.ts)
  'longtable:shares', // P2P share records incl. room secrets (p2p/share.ts)
])

/** Non-secret observability flag: a fully successful migration ran. */
export const MIGRATION_MARKER_KEY = 'longtable:secrets-migrated-v1'

/**
 * Whether a key holds secret material and must route to the Keystore
 * (H9): the crown-jewel keys themselves, plus their quarantine copies
 * (`<secret-key>.corrupt-<fnv-hex>`, see src/store/corrupt.ts). A
 * quarantine copy preserves a damaged secret's bytes — routing it to
 * plaintext localStorage would put the very material the Keystore
 * move protects back where it was. Quarantine keys are never
 * migrated (they are written after init, straight through kv) and
 * never appear in the migration report.
 */
export function isSecretKey(key: string): boolean {
  if (SECRET_KEYS.has(key)) return true
  for (const secret of SECRET_KEYS) {
    if (key.startsWith(`${secret}.corrupt-`)) return true
  }
  return false
}

/** Async Keystore backend. The Capacitor implementation is below; tests inject a fake. */
export interface SecretBackend {
  isAvailable(): Promise<boolean>
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
  keys(): Promise<string[]>
}

export type SecretMigrationOutcome =
  | 'moved' // legacy localStorage value moved to the secure store
  | 'moved-early-write' // value written before init finished; mirror was authoritative
  | 'already-secure' // secure store already held it (re-run / second launch)
  | 'absent' // no value anywhere; nothing to move
  | 'failed' // secure write or read-back verification failed; legacy copy kept
  | 'degraded' // secure store unavailable; value stays in localStorage

export interface SecretMigrationEntry {
  outcome: SecretMigrationOutcome
  /** A stale localStorage copy of this key was removed. */
  legacyCleared: boolean
}

export interface SecretsInitReport {
  secureAvailable: boolean
  initialized: boolean
  perKey: Record<string, SecretMigrationEntry>
  /** The migration marker was written (every key moved/secure/absent). */
  migratedMarkerSet: boolean
}

export interface SecretKeyPresence {
  inMemory: boolean
  inLocalStorage: boolean
  inSecureStore: boolean
}

export interface SecretsStatus {
  /** null = not probed yet this process. */
  secureAvailable: boolean | null
  initialized: boolean
  migrated: boolean
  pendingWrites: number
  lastPersistError: string | null
  keys: Record<string, SecretKeyPresence>
}

/** The store every secret accessor uses as its default `kv`. */
export type SecretKeyValueStore = KeyValueStore & {
  removeItem(key: string): void
}

export interface SecretStoreHandle {
  kv: SecretKeyValueStore
  initSecrets(): Promise<SecretsInitReport>
  /** The last init report, or null when init has not run yet. */
  lastInitReport(): SecretsInitReport | null
  flushSecrets(): Promise<void>
  secretsStatus(): Promise<SecretsStatus>
  isSecureStoreAvailable(): Promise<boolean>
  readSecureStoreRaw(key: string): Promise<string | null>
}

/** In-memory KeyValueStore with removeItem (tests + localStorage fallback). */
export function memoryLocalStore(): LocalStore {
  const map = new Map<string, string>()
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v)
    },
    removeItem: (k) => {
      map.delete(k)
    },
  }
}

class CapacitorSecureBackend implements SecretBackend {
  async isAvailable(): Promise<boolean> {
    if (!secureStoreAvailable()) return false
    try {
      return (await SecureStoreNative.isAvailable()).available
    } catch {
      return false
    }
  }

  async get(key: string): Promise<string | null> {
    const res = await SecureStoreNative.get({ key })
    return res.value ?? null
  }

  async set(key: string, value: string): Promise<void> {
    await SecureStoreNative.set({ key, value })
  }

  async remove(key: string): Promise<void> {
    await SecureStoreNative.remove({ key })
  }

  async keys(): Promise<string[]> {
    return (await SecureStoreNative.keys()).keys
  }
}

export function createSecretStore(
  backend: SecretBackend,
  local: LocalStore,
): SecretStoreHandle {
  const mirror = new Map<string, string>()
  let availability: boolean | null = null
  let availabilityPromise: Promise<boolean> | null = null
  let initialized = false
  let initPromise: Promise<SecretsInitReport> | null = null
  let lastReport: SecretsInitReport | null = null
  let lastPersistError: string | null = null
  let pendingCount = 0
  let tail: Promise<void> = Promise.resolve()

  function ensureAvailable(): Promise<boolean> {
    if (availability !== null) return Promise.resolve(availability)
    if (!availabilityPromise) {
      availabilityPromise = backend.isAvailable().then(
        (v) => {
          availability = v
          return v
        },
        () => {
          availability = false
          return false
        },
      )
    }
    return availabilityPromise
  }

  /** Ordered async persist queue. Never rejects; failures land in `lastPersistError`. */
  function enqueue(op: () => Promise<void>): void {
    pendingCount++
    tail = tail.then(async () => {
      try {
        await op()
      } catch (e) {
        lastPersistError = e instanceof Error ? e.message : String(e)
        console.warn('[longtable] secret persist failed:', lastPersistError)
      } finally {
        pendingCount--
      }
    })
  }

  function flushQueue(): Promise<void> {
    return tail
  }

  function safeLocalGet(key: string): string | null {
    try {
      return local.getItem(key)
    } catch {
      return null
    }
  }

  function safeLocalSet(key: string, value: string): void {
    try {
      local.setItem(key, value)
    } catch {
      /* storage unavailable — the in-memory mirror still answers reads */
    }
  }

  function safeLocalRemove(key: string): boolean {
    try {
      local.removeItem(key)
      return true
    } catch {
      return false
    }
  }

  const kv: SecretKeyValueStore = {
    getItem(key: string): string | null {
      if (!isSecretKey(key)) return safeLocalGet(key)
      if (mirror.has(key)) return mirror.get(key)!
      // Legacy / pre-init / direct-localStorage-write fallback: a secret
      // still in localStorage is readable until migration clears it.
      return safeLocalGet(key)
    },
    setItem(key: string, value: string): void {
      if (!isSecretKey(key)) {
        safeLocalSet(key, value)
        return
      }
      mirror.set(key, value)
      if (availability === false) {
        // Degraded mode: keep today's durability — the value lives in
        // localStorage until a launch with a working Keystore migrates it.
        safeLocalSet(key, value)
        return
      }
      if (availability === true) {
        enqueue(() => backend.set(key, value))
        return
      }
      enqueue(async () => {
        if (await ensureAvailable()) await backend.set(key, value)
        else safeLocalSet(key, value)
      })
    },
    removeItem(key: string): void {
      if (!isSecretKey(key)) {
        safeLocalRemove(key)
        return
      }
      mirror.delete(key)
      // Removing a secret removes EVERY copy of it: the Keystore entry
      // and any legacy localStorage copy (degraded mode, or a value
      // written before migration). Otherwise the localStorage fallback
      // in getItem would resurrect the "removed" value on the next read
      // — which is exactly what discarding a corrupt store must not do.
      safeLocalRemove(key)
      if (availability === false) {
        return
      }
      if (availability === true) {
        enqueue(() => backend.remove(key))
        return
      }
      enqueue(async () => {
        if (await ensureAvailable()) await backend.remove(key)
        else safeLocalRemove(key)
      })
    },
  }

  async function migrateOne(
    key: string,
    available: boolean,
  ): Promise<SecretMigrationEntry> {
    if (!available) {
      const legacy = safeLocalGet(key)
      if (legacy !== null) mirror.set(key, legacy)
      return { outcome: 'degraded', legacyCleared: false }
    }
    // Keystore-authoritative: a value there wins over any localStorage
    // copy, which can only be stale (a write that landed in the
    // Keystore before a kill skipped the clear, or a previous
    // migration's leftover). A read failure is 'failed', never
    // mistaken for 'absent' — a decrypt failure must not clear the
    // legacy copy or claim the key is gone.
    let stored: string | null
    try {
      stored = await backend.get(key)
    } catch {
      return { outcome: 'failed', legacyCleared: false }
    }
    const legacy = safeLocalGet(key)
    if (mirror.has(key)) {
      // A write landed before init finished; the mirror is newest.
      const value = mirror.get(key)!
      try {
        await backend.set(key, value)
        if ((await backend.get(key)) !== value) {
          return { outcome: 'failed', legacyCleared: false }
        }
      } catch {
        return { outcome: 'failed', legacyCleared: false }
      }
      return {
        outcome: 'moved-early-write',
        legacyCleared: legacy !== null ? safeLocalRemove(key) : false,
      }
    }
    if (stored !== null) {
      mirror.set(key, stored)
      return {
        outcome: 'already-secure',
        legacyCleared: legacy !== null ? safeLocalRemove(key) : false,
      }
    }
    if (legacy !== null) {
      try {
        await backend.set(key, legacy)
        // Verify the move before clearing the only other copy.
        if ((await backend.get(key)) !== legacy) {
          return { outcome: 'failed', legacyCleared: false }
        }
      } catch {
        return { outcome: 'failed', legacyCleared: false }
      }
      mirror.set(key, legacy)
      safeLocalRemove(key)
      return { outcome: 'moved', legacyCleared: true }
    }
    return { outcome: 'absent', legacyCleared: false }
  }

  async function initSecrets(): Promise<SecretsInitReport> {
    if (initPromise) return initPromise
    initPromise = (async () => {
      // Drain any pre-init writes first, so migration reads the newest state.
      await flushQueue()
      const available = await ensureAvailable()
      const perKey: Record<string, SecretMigrationEntry> = {}
      for (const key of SECRET_KEYS) {
        perKey[key] = await migrateOne(key, available)
      }
      let migratedMarkerSet = false
      if (
        available &&
        Object.values(perKey).every((r) => r.outcome !== 'failed')
      ) {
        try {
          local.setItem(MIGRATION_MARKER_KEY, '1')
          migratedMarkerSet = true
        } catch {
          /* marker is observability only — the migration stands without it */
        }
      }
      initialized = true
      const report: SecretsInitReport = {
        secureAvailable: available,
        initialized: true,
        perKey,
        migratedMarkerSet,
      }
      lastReport = report
      return report
    })()
    return initPromise
  }

  async function secretsStatus(): Promise<SecretsStatus> {
    let secureKeys: string[] = []
    if (availability === true) {
      try {
        secureKeys = await backend.keys()
      } catch {
        secureKeys = []
      }
    }
    const keys: Record<string, SecretKeyPresence> = {}
    for (const key of SECRET_KEYS) {
      keys[key] = {
        inMemory: mirror.has(key),
        inLocalStorage: safeLocalGet(key) !== null,
        inSecureStore: secureKeys.includes(key),
      }
    }
    return {
      secureAvailable: availability,
      initialized,
      migrated: safeLocalGet(MIGRATION_MARKER_KEY) === '1',
      pendingWrites: pendingCount,
      lastPersistError,
      keys,
    }
  }

  async function readSecureStoreRaw(key: string): Promise<string | null> {
    try {
      if (!(await ensureAvailable())) return null
      return await backend.get(key)
    } catch {
      return null
    }
  }

  // Best-effort flush when the page hides (app backgrounded / closed):
  // a kill in the milliseconds between a secret write and its Keystore
  // flush would otherwise lose that single write. Registered once per
  // store; guarded for non-browser runtimes (unit tests).
  try {
    if (typeof window !== 'undefined' && window.addEventListener) {
      window.addEventListener('pagehide', () => {
        void flushQueue()
      })
    }
  } catch {
    /* non-browser — no page lifecycle to hook */
  }

  return {
    kv,
    initSecrets,
    lastInitReport: () => lastReport,
    flushSecrets: flushQueue,
    secretsStatus,
    isSecureStoreAvailable: ensureAvailable,
    readSecureStoreRaw,
  }
}

function detectLocalStore(): LocalStore {
  try {
    if (typeof localStorage !== 'undefined' && localStorage !== null) {
      return localStorage
    }
  } catch {
    /* localStorage inaccessible (private mode, node) — fall through */
  }
  return memoryLocalStore()
}

let current: SecretStoreHandle = createSecretStore(
  new CapacitorSecureBackend(),
  detectLocalStore(),
)

/**
 * The default store for every secret accessor (identity, vault,
 * friends, ATProto session, local-API settings, hubs, shares).
 * Non-secret keys pass straight through to localStorage.
 */
export const secretKv: SecretKeyValueStore = {
  getItem: (key) => current.kv.getItem(key),
  setItem: (key, value) => current.kv.setItem(key, value),
  removeItem: (key) => current.kv.removeItem(key),
}

/** Move legacy localStorage secrets into the Keystore. Call first at app startup. */
export function initSecrets(): Promise<SecretsInitReport> {
  return current.initSecrets()
}

/** The last migration report, or null when init has not run yet. */
export function lastInitReport(): SecretsInitReport | null {
  return current.lastInitReport()
}

/** Drain the async Keystore persist queue. */
export function flushSecrets(): Promise<void> {
  return current.flushSecrets()
}

export function secretsStatus(): Promise<SecretsStatus> {
  return current.secretsStatus()
}

export function isSecureStoreAvailable(): Promise<boolean> {
  return current.isSecureStoreAvailable()
}

/** Raw Keystore read (bypasses the mirror). Null when unavailable/absent. */
export function readSecureStoreRaw(key: string): Promise<string | null> {
  return current.readSecureStoreRaw(key)
}

/**
 * Test hook (same precedent as identityFromSeed): swap the singleton's
 * backend + local store so unit tests can drive the real wiring with a
 * fake Keystore. Vitest isolates modules per test file, so a reset here
 * cannot leak into another file's tests.
 */
export function resetSecretStoreForTests(
  backend: SecretBackend,
  local: LocalStore,
): void {
  current = createSecretStore(backend, local)
}
