/**
 * Hub registry — Phase 4 (multi-hub client).
 *
 * A "hub" is a bundle of service endpoints a user chooses to rendezvous
 * through: WebRTC signaling, STUN/TURN, the AppView search API, and a
 * default PDS for publishing. Hubs are trusted for availability and NAT
 * traversal ONLY — never for content (see PLAN.md trust model). All user
 * data (recipes, friends, shares, identity) is local and hub-independent:
 * switching hubs changes endpoints, never data.
 *
 * The registry lives in the Android Keystore (src/secrets/secretStore.ts)
 * on native — in localStorage on web — under HUBS_KEY as
 *   { hubs: HubConfig[], activeId: string }
 * On first run it is seeded with the built-in default hub (the Phase 1–3
 * dev endpoints), so behavior is unchanged until the user
 * adds or selects another hub.
 *
 * Rendezvous: y-webrtc accepts a LIST of signaling servers and maintains a
 * connection to each. Providers are therefore built with the rendezvous
 * list — every known hub, active first — so peers sharing ANY hub find
 * each other, and the death of one hub does not end the session (E8).
 */
import type { KeyValueStore } from '../identity/identity'
import { secretKv } from '../secrets/secretStore'

export interface HubConfig {
  id: string
  name: string
  /** wss:// signaling endpoint (y-webrtc) */
  signalingUrl: string
  /** stun: URL (optional) */
  stunUrl?: string
  /** turn: URL (optional) */
  turnUrl?: string
  turnUsername?: string
  turnCredential?: string
  /** AppView search API base URL */
  appviewUrl: string
  /** Default PDS base URL offered at publishing sign-in */
  pdsUrl: string
}

export const HUBS_KEY = 'longtable:hubs:v1'

export const DEFAULT_HUB_ID = 'local-dev'

/**
 * Build-time dev TURN password for the seeded hub. Non-release builds
 * (CI proofs, dev) inject VITE_LT_DEV_TURN_PASSWORD from the ops
 * password store; release builds never set it, so the published app
 * ships with no TURN credential for the dev hub at all.
 */
const DEV_TURN_PASSWORD: string | undefined =
  import.meta.env.VITE_LT_DEV_TURN_PASSWORD || undefined

/**
 * Recognizing the pre-scrub seeded hub WITHOUT shipping its values.
 *
 * Existing installs carry the old default-hub id/name (and the burned
 * dev TURN credential) in their localStorage registry; loadRegistry
 * renames the entry in place (see migrateLegacyDefaultHub). Those old
 * values must never appear in this repository or in a shipped bundle
 * again -- not even as string fragments, which concatenate at build
 * time. The migration therefore matches on FNV-1a-64 digests of the
 * old values instead of the values themselves.
 *
 * Why a non-cryptographic hash: the old values are already public
 * (pre-scrub git history, old shipped bundles) and the credential is
 * burned/rotated, so the digest is NOT a secrecy boundary -- it only
 * lets the migration recognize the values without writing them down.
 * FNV-1a-64 is deterministic across JS engines (BigInt arithmetic is
 * exact), synchronous (this migration runs inside the synchronous
 * loadRegistry, reachable from React render initializers before
 * libsodium's WASM init -- so the codebase's BLAKE2b helper, which
 * needs `await cryptoReady()`, cannot be used here), and needs no new
 * dependency. The digests below are derived from the values that
 * actually shipped, in d725e40:src/hubs/hubs.ts (the scrub parent);
 * ci/check-legacy-hub-digests.py re-derives them from git history at
 * build time and fails the pipeline on any mismatch, so a wrong
 * digest can never ship silently again. The unit tests pin the hash
 * against the FNV-1a-64 test vectors.
 */
export function legacyMatchHash(value: string): string {
  let hash = BigInt('0xcbf29ce484222325')
  const bytes = new TextEncoder().encode(value)
  for (const b of bytes) {
    hash ^= BigInt(b)
    hash = (hash * BigInt('0x100000001b3')) & BigInt('0xffffffffffffffff')
  }
  return hash.toString(16).padStart(16, '0')
}

/**
 * FNV-1a-64 digests of the pre-scrub legacy hub id, name, and TURN
 * credential — the values that actually shipped (d725e40:src/hubs/hubs.ts).
 *
 * Correction (2026-11-15, review C1): the digests committed by 440c8ac
 * hashed the fragment-joined strings from 0d4423e, which never shipped,
 * so migrateLegacyDefaultHub could never fire on a real device. The
 * corrected digests below are the ones ci/check-legacy-hub-digests.py
 * re-derives from the pre-scrub file at build time.
 */
export interface LegacyHubHashes {
  id: string
  name: string
  credential: string
}

export const LEGACY_HUB_HASHES: LegacyHubHashes = {
  id: '5e9a8751d9a03b3f',
  name: '7eca6bcb61324caf',
  credential: '7d1624db0754b5f6',
}

/**
 * The 440c8ac digests (fragment-joined strings; never shipped), matched
 * defensively for ONE release only, in case any device carries
 * fragment-valued entries. Remove after that release: the fragment
 * strings never shipped, so no real device should need this past one
 * release. ci/check-legacy-hub-digests.py pins this set to the digests
 * committed by 440c8ac.
 */
export const LEGACY_HUB_HASHES_V0: LegacyHubHashes = {
  id: 'aa3d84ecc2a466dc',
  name: '7dadf2009a1fa830',
  credential: '7572d0be55d53e4f',
}

/** The built-in hub: Phase 1–3 dev endpoints (emulator view of the dev rig). */
export const DEFAULT_HUB: HubConfig = {
  id: DEFAULT_HUB_ID,
  name: 'Local dev hub',
  signalingUrl: 'wss://10.0.2.2:4444',
  stunUrl: 'stun:10.0.2.2:3478',
  turnUrl: 'turn:10.0.2.2:3478',
  turnUsername: 'longtable',
  turnCredential: DEV_TURN_PASSWORD,
  appviewUrl: 'http://localhost:3210',
  pdsUrl: 'http://localhost:2583',
}

/**
 * Rename a persisted pre-scrub default-hub entry in place: new id,
 * the default name restored (only when the entry still carries the
 * legacy default name — a user-renamed hub keeps its name), the burned
 * TURN credential swapped for the build-injected one or dropped, and
 * activeId followed. All other fields are preserved; no entry is added
 * or removed, so an existing hub list migrates without loss or
 * duplication. Returns true when anything changed.
 *
 * Matching is by digest (see legacyMatchHash): the stored id, name,
 * and credential are hashed and compared against the digest sets, so
 * the old values never appear in this file or the shipped bundle.
 * `hashes` is injectable so unit tests can exercise the same code path
 * with synthetic values; it accepts one set or a list of sets.
 * Production matches both LEGACY_HUB_HASHES and LEGACY_HUB_HASHES_V0
 * (the corrected digests first); the name/credential checks use the
 * same set the id matched, so a mixed entry keeps the fields it does
 * not recognize. See LEGACY_HUB_HASHES_V0 for the one-release scope.
 */
export function migrateLegacyDefaultHub(
  reg: HubRegistry,
  hashes: LegacyHubHashes | LegacyHubHashes[] = [
    LEGACY_HUB_HASHES,
    LEGACY_HUB_HASHES_V0,
  ],
): boolean {
  const sets = Array.isArray(hashes) ? hashes : [hashes]
  const legacy = reg.hubs.find((h) =>
    sets.some((s) => legacyMatchHash(h.id) === s.id),
  )
  if (!legacy) return false
  const matched = sets.find((s) => legacyMatchHash(legacy.id) === s.id) as LegacyHubHashes
  legacy.id = DEFAULT_HUB_ID
  if (legacyMatchHash(legacy.name) === matched.name) legacy.name = DEFAULT_HUB.name
  if (
    legacy.turnCredential !== undefined &&
    legacyMatchHash(legacy.turnCredential) === matched.credential
  ) {
    if (DEV_TURN_PASSWORD) legacy.turnCredential = DEV_TURN_PASSWORD
    else delete legacy.turnCredential
  }
  if (sets.some((s) => legacyMatchHash(reg.activeId) === s.id)) {
    reg.activeId = DEFAULT_HUB_ID
  }
  return true
}

export interface HubRegistry {
  hubs: HubConfig[]
  activeId: string
}

/**
 * The default store: the secure store (src/secrets/secretStore.ts).
 * It routes the registry (which carries TURN credentials) to the
 * Keystore on Android and to localStorage on web, and it never throws
 * when localStorage is absent (unit tests run under node) — endpoint
 * resolution must never crash a caller that only wanted the default hub.
 */
export function defaultKv(): KeyValueStore {
  return secretKv
}

function isHubConfig(o: unknown): o is HubConfig {
  if (typeof o !== 'object' || o === null) return false
  const h = o as Record<string, unknown>
  return (
    typeof h.id === 'string' && !!h.id &&
    typeof h.name === 'string' &&
    typeof h.signalingUrl === 'string' && !!h.signalingUrl &&
    typeof h.appviewUrl === 'string' && !!h.appviewUrl &&
    typeof h.pdsUrl === 'string' && !!h.pdsUrl
  )
}

function loadRegistry(kv: KeyValueStore): HubRegistry {
  try {
    const raw = kv.getItem(HUBS_KEY)
    if (raw) {
      const obj: unknown = JSON.parse(raw)
      if (
        typeof obj === 'object' && obj !== null &&
        Array.isArray((obj as HubRegistry).hubs) &&
        (obj as HubRegistry).hubs.length > 0 &&
        (obj as HubRegistry).hubs.every(isHubConfig)
      ) {
        const reg = obj as HubRegistry
        if (migrateLegacyDefaultHub(reg)) saveRegistry(reg, kv)
        if (!reg.hubs.some((h) => h.id === reg.activeId)) {
          reg.activeId = reg.hubs[0].id
        }
        return reg
      }
    }
  } catch {
    /* fall through to the seeded default */
  }
  return { hubs: [{ ...DEFAULT_HUB }], activeId: DEFAULT_HUB_ID }
}

function saveRegistry(reg: HubRegistry, kv: KeyValueStore): void {
  try {
    kv.setItem(HUBS_KEY, JSON.stringify(reg))
  } catch {
    /* storage unavailable — hub selection is session-only then */
  }
}

/** All configured hubs, active hub first. */
export function listHubs(kv: KeyValueStore = defaultKv()): HubConfig[] {
  const reg = loadRegistry(kv)
  const active = reg.hubs.find((h) => h.id === reg.activeId) ?? reg.hubs[0]
  return [active, ...reg.hubs.filter((h) => h.id !== active.id)]
}

/** The currently selected hub. */
export function getActiveHub(kv: KeyValueStore = defaultKv()): HubConfig {
  return listHubs(kv)[0]
}

/** Select a hub by id. Purely an endpoint change — no data moves. */
export function setActiveHub(id: string, kv: KeyValueStore = defaultKv()): HubConfig {
  const reg = loadRegistry(kv)
  const hub = reg.hubs.find((h) => h.id === id)
  if (!hub) throw new Error(`unknown hub: ${id}`)
  reg.activeId = id
  saveRegistry(reg, kv)
  return hub
}

let idCounter = 0

/** Add a hub; returns it (with its generated id). Does not activate it. */
export function addHub(
  input: Omit<HubConfig, 'id'> & { id?: string },
  kv: KeyValueStore = defaultKv(),
): HubConfig {
  const reg = loadRegistry(kv)
  const id =
    input.id ??
    `hub-${Date.now().toString(36)}-${(idCounter++).toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
  if (reg.hubs.some((h) => h.id === id)) throw new Error(`duplicate hub id: ${id}`)
  const hub: HubConfig = { ...input, id }
  if (!isHubConfig(hub)) throw new Error('invalid hub configuration')
  reg.hubs.push(hub)
  saveRegistry(reg, kv)
  return hub
}

/** Replace a hub's fields in place (id is immutable). */
export function updateHub(
  id: string,
  patch: Partial<Omit<HubConfig, 'id'>>,
  kv: KeyValueStore = defaultKv(),
): HubConfig {
  const reg = loadRegistry(kv)
  const i = reg.hubs.findIndex((h) => h.id === id)
  if (i < 0) throw new Error(`unknown hub: ${id}`)
  const next = { ...reg.hubs[i], ...patch, id }
  if (!isHubConfig(next)) throw new Error('invalid hub configuration')
  reg.hubs[i] = next
  saveRegistry(reg, kv)
  return next
}

/**
 * Remove a hub. Removing the active hub activates the first remaining one.
 * The built-in default hub can be removed like any other once another hub
 * exists — a hub is just endpoints; nothing else references it.
 */
export function removeHub(id: string, kv: KeyValueStore = defaultKv()): void {
  const reg = loadRegistry(kv)
  if (reg.hubs.length <= 1) throw new Error('cannot remove the last hub')
  reg.hubs = reg.hubs.filter((h) => h.id !== id)
  if (reg.activeId === id) reg.activeId = reg.hubs[0].id
  saveRegistry(reg, kv)
}

/**
 * ICE servers from ALL configured hubs, the given (or active) hub first.
 * The redundancy is the point (E8): if one hub's TURN is dead, peers can
 * still relay via any other hub's TURN. Duplicate URLs are dropped —
 * first occurrence wins, so the primary hub's credentials apply to a
 * shared TURN endpoint.
 */
export function getIceServers(
  hub?: HubConfig,
  kv: KeyValueStore = defaultKv(),
): RTCIceServer[] {
  const hubs = listHubs(kv)
  const ordered = hub ? [hub, ...hubs.filter((h) => h.id !== hub.id)] : hubs
  const servers: RTCIceServer[] = []
  const seen = new Set<string>()
  for (const h of ordered) {
    if (h.stunUrl && !seen.has(h.stunUrl)) {
      seen.add(h.stunUrl)
      servers.push({ urls: h.stunUrl })
    }
    if (h.turnUrl && !seen.has(h.turnUrl)) {
      seen.add(h.turnUrl)
      const turn: RTCIceServer = { urls: h.turnUrl }
      if (h.turnUsername) turn.username = h.turnUsername
      if (h.turnCredential) turn.credential = h.turnCredential
      servers.push(turn)
    }
  }
  return servers
}

/**
 * The rendezvous list for y-webrtc: `primary` first (e.g. the signaling a
 * share/friend invite was created with), then every configured hub's
 * signaling, deduplicated. Peers rendezvous on ANY of these — this is the
 * hub-death failover mechanism: if the primary dies, the remaining
 * connections were already established and keep working.
 */
export function getSignalingUrls(
  primary?: string,
  kv: KeyValueStore = defaultKv(),
): string[] {
  const urls: string[] = []
  const push = (u?: string) => {
    if (u && !urls.includes(u)) urls.push(u)
  }
  push(primary)
  for (const h of listHubs(kv)) push(h.signalingUrl)
  return urls
}
