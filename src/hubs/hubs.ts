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
 * The registry lives in localStorage under HUBS_KEY as
 *   { hubs: HubConfig[], activeId: string }
 * On first run it is seeded with the built-in default hub (the Phase 1–3
 * dev endpoints on devbox), so behavior is unchanged until the user
 * adds or selects another hub.
 *
 * Rendezvous: y-webrtc accepts a LIST of signaling servers and maintains a
 * connection to each. Providers are therefore built with the rendezvous
 * list — every known hub, active first — so peers sharing ANY hub find
 * each other, and the death of one hub does not end the session (E8).
 */
import type { KeyValueStore } from '../identity/identity'

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

export const DEFAULT_HUB_ID = 'devbox-dev'

/** The built-in hub: Phase 1–3 dev endpoints (devbox, emulator view). */
export const DEFAULT_HUB: HubConfig = {
  id: DEFAULT_HUB_ID,
  name: 'Devbox (dev)',
  signalingUrl: 'wss://10.0.2.2:4444',
  stunUrl: 'stun:10.0.2.2:3478',
  turnUrl: 'turn:10.0.2.2:3478',
  turnUsername: 'longtable',
  turnCredential: 'dev-turn-password',
  appviewUrl: 'http://localhost:3210',
  pdsUrl: 'http://localhost:2583',
}

interface HubRegistry {
  hubs: HubConfig[]
  activeId: string
}

/**
 * The default store: localStorage where it exists (the app), else a
 * process-local memory map (unit tests run under node, where touching
 * `localStorage` throws). Endpoint resolution must never crash a caller
 * that only wanted the default hub.
 */
const memoryFallback = new Map<string, string>()
export function defaultKv(): KeyValueStore {
  try {
    if (typeof localStorage !== 'undefined') return localStorage
  } catch {
    /* fall through */
  }
  return {
    getItem: (k) => (memoryFallback.has(k) ? memoryFallback.get(k)! : null),
    setItem: (k, v) => {
      memoryFallback.set(k, v)
    },
  }
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

/** ICE servers for a hub (defaults to the active hub). */
export function getIceServers(
  hub: HubConfig = getActiveHub(),
): RTCIceServer[] {
  const servers: RTCIceServer[] = []
  if (hub.stunUrl) servers.push({ urls: hub.stunUrl })
  if (hub.turnUrl) {
    const turn: RTCIceServer = { urls: hub.turnUrl }
    if (hub.turnUsername) turn.username = hub.turnUsername
    if (hub.turnCredential) turn.credential = hub.turnCredential
    servers.push(turn)
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
