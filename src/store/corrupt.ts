/**
 * Corrupt-store handling (H9, with H8's identity damage).
 *
 * The old loaders caught every JSON.parse failure and returned the
 * empty default — and the next save then persisted that default over
 * the corrupt bytes, destroying the user's data (friends, key vault,
 * shares, received mapping, hub registry, publications, API settings).
 *
 * The rule now, for every JSON store in the app:
 *
 *   1. Loaders distinguish ABSENT from CORRUPT. Absent (never written)
 *      reads as the empty default, exactly as before. Corrupt (present
 *      but unparseable, or the wrong top-level shape) also reads as the
 *      safe empty in-memory view — but it is recorded, not swallowed.
 *   2. Corrupt bytes are QUARANTINED, never deleted. The raw value is
 *      copied under a deterministic key —
 *      `<store-key>.corrupt-<fnv1a64(raw)>` — so the same corrupt bytes
 *      always land under the same quarantine key (re-detecting them on
 *      the next launch does not pile up copies), and the live corrupt
 *      value stays in place as the primary copy until something
 *      deliberately replaces it. Quarantine keys route to the Keystore
 *      on native exactly like the store keys they preserve (see
 *      isSecretKey in secrets/secretStore.ts).
 *   3. Saves REFUSE to overwrite a corrupt store. Every writer reads
 *      through its loader first (all current writers do), the loader
 *      records the corruption in the module registry, and the writer
 *      throws CorruptStoreError before touching the key. The one
 *      exception is a user-confirmed backup restore, which clears the
 *      registry entries for the stores it replaces first — restore is
 *      the deliberate replacement path, and the quarantine copies
 *      already preserve the bytes.
 *   4. Corruption is SURFACED. listCorruptStores() feeds the banner in
 *      App.tsx (and the blocking identity-damaged screen for the
 *      identity key). The registry is process-global, keyed by store
 *      key — the app reads each store through one kv or another
 *      (secretKv vs raw localStorage in the backup paths), but a store
 *      key names one logical store either way.
 *   5. A corrupt store HEALS when a valid value is read again (a
 *      successful restore writes valid JSON; the next load clears the
 *      entry) or when the user discards the damaged copy
 *      (discardCorruptStore — the quarantine copy keeps the bytes).
 *      The identity secret is NEVER discarded through this path: a
 *      discarded identity key would let the app mint a fresh DID and
 *      silently orphan friends + published recipes. Identity damage is
 *      healed by restore only.
 *
 * The registry is in-memory only: corruption is re-detected from the
 * stored bytes on every launch, so nothing about it needs persisting.
 * Tests reset it with resetCorruptRegistryForTests (vitest isolates
 * modules per test file, but not between tests in one file).
 */
import type { KeyValueStore } from '../identity/identity'

/** Thrown when a save would overwrite a corrupt store. */
export class CorruptStoreError extends Error {
  /** The store key that is corrupt (e.g. 'longtable:friends'). */
  readonly storeKey: string
  constructor(storeKey: string, label: string) {
    super(
      `The saved ${label} could not be read — it looks damaged. Nothing was overwritten. ` +
        'Restore from an encrypted backup to recover it.',
    )
    this.name = 'CorruptStoreError'
    this.storeKey = storeKey
  }
}

export interface CorruptStoreEntry {
  /** The store key whose live value is corrupt. */
  key: string
  /** The quarantine key holding the preserved raw bytes. */
  quarantineKey: string
  /** Why the value was judged corrupt (never contains stored bytes). */
  reason: string
  /** ISO timestamp of the first detection in this process. */
  detectedAt: string
}

/** Plain-language label for a store key, for UI copy. */
export function corruptStoreLabel(key: string): string {
  switch (key) {
    case 'longtable:identity-secret':
      return 'device identity key'
    case 'longtable:friends':
      return 'friend list'
    case 'longtable:key-vault':
      return 'recipe key vault'
    case 'longtable:shares':
      return 'P2P share list'
    case 'longtable:received-shares':
      return 'received-shares list'
    case 'longtable:hubs:v1':
      return 'hub registry'
    case 'longtable:publications:v1':
      return 'publications list'
    case 'longtable:localapi':
      return 'local API settings'
    default:
      return 'saved data'
  }
}

const QUARANTINE_INFIX = '.corrupt-'

/**
 * FNV-1a-64 hex — same algorithm as hubs.ts legacyMatchHash, copied here
 * so this module does not depend on a hub-migration helper. Synchronous
 * and deterministic across engines. NOT a secrecy boundary: the
 * quarantine key only has to be stable for a given corrupt value.
 */
export function fnv1a64Hex(value: string): string {
  let hash = BigInt('0xcbf29ce484222325')
  const bytes = new TextEncoder().encode(value)
  for (const b of bytes) {
    hash ^= BigInt(b)
    hash = (hash * BigInt('0x100000001b3')) & BigInt('0xffffffffffffffff')
  }
  return hash.toString(16).padStart(16, '0')
}

/**
 * Deterministic quarantine key for a corrupt value: the same bytes
 * always map to the same key, so re-detecting the same corruption
 * (next launch, another loader) overwrites the identical copy instead
 * of piling up timestamped duplicates.
 */
export function quarantineKeyFor(key: string, raw: string): string {
  return `${key}${QUARANTINE_INFIX}${fnv1a64Hex(raw)}`
}

const registry = new Map<string, CorruptStoreEntry>()

/** Every corrupt store detected in this process, sorted by key. */
export function listCorruptStores(): CorruptStoreEntry[] {
  return [...registry.values()].sort((a, b) => a.key.localeCompare(b.key))
}

/** Whether the store key is currently recorded as corrupt. */
export function isStoreCorrupt(key: string): boolean {
  return registry.has(key)
}

/**
 * Forget a corruption record (restore path only): the caller is about
 * to deliberately replace the store's value with validated data, and
 * the quarantine copy already preserves the old bytes. Never call this
 * to make a save succeed without replacing the value.
 */
export function clearCorruptStore(key: string): void {
  registry.delete(key)
}

/** Test hook: empty the registry between tests in one file. */
export function resetCorruptRegistryForTests(): void {
  registry.clear()
}

/**
 * Record a corrupt value: preserve the raw bytes under their
 * deterministic quarantine key and register the entry. Idempotent for
 * the same bytes. Best-effort quarantine: if the copy cannot be
 * written, the live corrupt value stays in place, so the bytes are
 * not lost — the next load re-detects and retries.
 */
export function noteCorruptStore(
  kv: KeyValueStore,
  key: string,
  raw: string,
  reason: string,
): CorruptStoreEntry {
  const quarantineKey = quarantineKeyFor(key, raw)
  const existing = registry.get(key)
  if (existing && existing.quarantineKey === quarantineKey) return existing
  try {
    kv.setItem(quarantineKey, raw)
  } catch {
    /* quarantine is best-effort — see the doc comment above */
  }
  const entry: CorruptStoreEntry = {
    key,
    quarantineKey,
    reason,
    detectedAt: new Date().toISOString(),
  }
  registry.set(key, entry)
  return entry
}

export type StoredJsonRead =
  | { status: 'absent' }
  | { status: 'ok'; value: unknown; raw: string }
  | { status: 'corrupt'; raw: string; reason: string }

/**
 * Read + parse a stored JSON value, distinguishing absent from corrupt.
 * A valid read clears any earlier corruption record for the key (the
 * store healed — e.g. a restore wrote good JSON); an absent read does
 * the same (the value is gone, so nothing corrupt remains). A corrupt
 * read quarantines the bytes and records the entry. A getItem that
 * throws is reported as absent without touching the registry: the
 * value is unreadable, not proven corrupt, and a save would fail on
 * the same storage anyway.
 */
export function readStoredJson(kv: KeyValueStore, key: string): StoredJsonRead {
  let raw: string | null
  try {
    raw = kv.getItem(key)
  } catch {
    return { status: 'absent' }
  }
  if (raw === null || raw === '') {
    registry.delete(key)
    return { status: 'absent' }
  }
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    noteCorruptStore(kv, key, raw, 'not valid JSON')
    return { status: 'corrupt', raw, reason: 'not valid JSON' }
  }
  registry.delete(key)
  return { status: 'ok', value, raw }
}

/**
 * The save-side choke point: throw when the store is recorded corrupt.
 * Every writer reads through its loader first (all current writers
 * do), so the registry is populated before any save is attempted.
 * Callers that must deliberately replace a corrupt store (backup
 * restore) clear the registry entry first — see clearCorruptStore.
 */
export function assertStoreWritable(key: string): void {
  if (registry.has(key)) {
    throw new CorruptStoreError(key, corruptStoreLabel(key))
  }
}

/**
 * A store that can also delete a key (localStorage-shaped). Used only
 * by discardCorruptStore; plain KeyValueStore implementations without
 * removeItem fall back to writing an empty value (which loaders read
 * as absent).
 */
export interface RemovableStore extends KeyValueStore {
  removeItem?: (key: string) => void
}

/**
 * Discard the damaged live value of a store so it heals to its
 * absent/default state (re-enter hubs, re-publish, re-enable the API,
 * or restore from backup afterwards). The quarantine copy keeps the
 * bytes, so discarding loses nothing that was recoverable.
 *
 * NEVER call this for the identity secret ('longtable:identity-secret'):
 * discarding it would let the app mint a fresh DID and silently
 * orphan friends + published recipes. Identity damage is healed by
 * backup restore only.
 */
export function discardCorruptStore(kv: RemovableStore, key: string): void {
  if (typeof kv.removeItem === 'function') {
    kv.removeItem(key)
  } else {
    kv.setItem(key, '')
  }
  registry.delete(key)
}
