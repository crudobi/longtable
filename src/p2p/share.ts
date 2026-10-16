/**
 * P2P sharing via y-webrtc. One room per shared recipe; the signaling server
 * only routes WebRTC handshake messages and never sees recipe content.
 *
 * Flow:
 *   host:  shareRecipe(id) -> QR payload -> guest scans/pastes
 *   guest: joinShare(payload) -> empty Y.Doc with the SAME guid -> y-webrtc
 *          sync populates it from the host -> registered in the guest's index
 *
 * Room authentication: every share created by this build carries a random
 * 32-byte secret in its payload. Both sides pass it to y-webrtc as the
 * room password, so signaling traffic for the room is encrypted with it
 * and a peer without the secret cannot join or inject updates — knowing
 * the recipe id (which is NOT a secret: publishing a recipe exposes it as
 * the record's rkey) is no longer enough. Payloads from older builds have
 * no secret and still join passwordless: they stay exactly as open as
 * they always were (see parseSharePayload).
 *
 * Shares persist in localStorage and are rejoined on every launch, so peers
 * reconnect after app restarts (this is also what heals a partition).
 */
import * as Y from 'yjs'
import { getOrCreateDoc, getRepo } from '../store/repo'
import { RECIPE_MAP, registerSharedRecipe } from '../store/recipes'
import { getActiveHub, getIceServers, getSignalingUrls } from '../hubs/hubs'

// y-webrtc is lazy-loaded on first joinRoom: it pulls in WebRTC shims that we
// don't want evaluated at app startup (and it keeps the initial bundle lean).
// The type is imported statically for TypeScript.
import type { WebrtcProvider as WebrtcProviderType } from 'y-webrtc'

/**
 * The built-in default hub's signaling URL (kept for compatibility).
 * New code resolves endpoints from the hub registry instead:
 * `getActiveHub().signalingUrl`, `getIceServers()`, `getSignalingUrls()`.
 */
export const DEFAULT_SIGNALING_URL = 'wss://10.0.2.2:4444'
// TURN server for NAT traversal between emulators/devices.
// The server only relays encrypted WebRTC packets; it never sees content.
const TURN_URL = 'turn:10.0.2.2:3478'
const TURN_USER = 'longtable'
const TURN_PASS = 'dev-turn-password'

const SHARES_KEY = 'longtable:shares'

/** ICE servers for the built-in default hub (compat export; live code uses
 * `getIceServers()` from the hub registry so the ACTIVE hub supplies TURN). */
export const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:10.0.2.2:3478' },
  { urls: TURN_URL, username: TURN_USER, credential: TURN_PASS },
]

/** Encode a Uint8Array as base64 (browser-safe). */
function u8ToBase64(u8: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i])
  return btoa(s)
}

/** Decode a base64 string to Uint8Array (browser-safe). */
function base64ToU8(b64: string): Uint8Array {
  const s = atob(b64)
  const u8 = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i)
  return u8
}

export interface SharePayload {
  v: 1
  /** y-webrtc room both devices join */
  room: string
  /** signaling server URL both devices use */
  signaling: string
  /** recipe id (= Yjs doc guid, identical on both devices) */
  recipeId: string
  /** human-readable, shown on the join confirmation */
  title: string
  /** base64-encoded Yjs state update (snapshot) for instant initial sync */
  snapshot: string
  /**
   * Base64 32-byte room secret, used as the y-webrtc password. Absent in
   * payloads minted by builds before room authentication existed.
   */
  secret?: string
}

export interface ShareRecord {
  recipeId: string
  room: string
  signaling: string
  role: 'host' | 'guest'
  /** Room secret from the payload; absent for legacy (pre-auth) shares. */
  secret?: string
}

/** A fresh random room secret (32 bytes, base64). */
function newShareSecret(): string {
  return u8ToBase64(crypto.getRandomValues(new Uint8Array(32)))
}

const providers = new Map<string, WebrtcProviderType>()

/** Callbacks fired when any shared doc updates (local or remote edit). */
const updateListeners = new Set<() => void>()

/**
 * Subscribe to shared-doc updates. The app uses this to refresh the list and
 * the open detail view when a friend's edit arrives. Returns an unsubscribe.
 */
/**
 * Debug hook for e2e proof: export/import Yjs updates as base64.
 * Used to verify CRDT merge when y-webrtc transport is unavailable
 * (e.g. emulator NAT). Not for production use.
 */
export function onShareUpdate(cb: () => void): () => void {
  updateListeners.add(cb)
  return () => {
    updateListeners.delete(cb)
  }
}

function notifyUpdate(): void {
  for (const cb of updateListeners) {
    try {
      cb()
    } catch (e) {
      console.warn('share update listener failed', e)
    }
  }
}

export function roomForRecipe(recipeId: string): string {
  return `longtable-share-${recipeId}`
}

function loadShares(): ShareRecord[] {
  try {
    const raw = localStorage.getItem(SHARES_KEY)
    if (!raw) return []
    const arr: unknown = JSON.parse(raw)
    return Array.isArray(arr) ? (arr as ShareRecord[]) : []
  } catch {
    return []
  }
}

function saveShare(rec: ShareRecord): void {
  const shares = loadShares().filter((s) => s.recipeId !== rec.recipeId)
  shares.push(rec)
  try {
    localStorage.setItem(SHARES_KEY, JSON.stringify(shares))
  } catch {
    /* storage full or unavailable — sharing still works for this session */
  }
}

/** The saved share for a recipe, if this device shares or joined it. */
export function getShare(recipeId: string): ShareRecord | undefined {
  return loadShares().find((s) => s.recipeId === recipeId)
}

/** Number of connected peers in a room (excluding self), 0 when not joined. */
export function peerCount(room: string): number {
  const p: WebrtcProviderType | undefined = providers.get(room)
  if (!p) return 0
  return Math.max(0, p.awareness.getStates().size - 1)
}

async function joinRoom(
  room: string,
  doc: Y.Doc,
  signaling: string,
  secret?: string,
): Promise<WebrtcProviderType> {
  let p = providers.get(room)
  if (!p) {
    const { WebrtcProvider } = await import('y-webrtc')
    p = new WebrtcProvider(room, doc, {
      // Rendezvous list: this share's signaling first, then every hub in
      // the registry — peers find each other on ANY live hub (Phase 4).
      signaling: getSignalingUrls(signaling),
      // Room password: y-webrtc encrypts the room's signaling traffic
      // with it; peers without the secret cannot join or inject updates.
      // Omitted entirely for legacy shares (no secret in their payload),
      // which remain passwordless exactly as before.
      ...(secret ? { password: secret } : {}),
      peerOpts: {
        config: {
          iceServers: getIceServers(),
        },
      },
    })
    providers.set(room, p)
    doc.on('update', notifyUpdate)
  }
  return p
}

/**
 * Destroy every share provider (hub switch): the next join/rejoin rebuilds
 * providers against the new active hub's endpoints. Docs and share records
 * are untouched — switching hubs loses nothing.
 */
export function destroyAllShareProviders(): void {
  for (const p of providers.values()) {
    try {
      p.destroy()
    } catch {
      /* already gone */
    }
  }
  providers.clear()
}

/**
 * Host side: start sharing one of my recipes. Idempotent — calling twice
 * returns the same room. The returned payload is what goes in the QR code.
 */
export async function shareRecipe(
  recipeId: string,
  title: string,
  signaling: string = getActiveHub().signalingUrl,
): Promise<SharePayload> {
  const repo = getRepo()
  const doc = await getOrCreateDoc(repo, recipeId)
  const room = roomForRecipe(recipeId)
  // Reuse the share's existing secret so re-sharing is idempotent; a
  // legacy record (pre-auth) gains a fresh secret here, which upgrades
  // the share: earlier guests hold a passwordless payload and must be
  // given the new code to keep syncing.
  const secret = getShare(recipeId)?.secret ?? newShareSecret()
  await joinRoom(room, doc, signaling, secret)
  saveShare({ recipeId, room, signaling, role: 'host', secret })
  // Embed a snapshot so the guest gets content instantly, even if y-webrtc
  // hasn't synced yet. y-webrtc handles live updates after the join.
  const snapshot = u8ToBase64(Y.encodeStateAsUpdate(doc))
  return { v: 1 as const, room, signaling, recipeId, title, snapshot, secret }
}

/**
 * Guest side: join a share from a scanned or pasted payload. Creates the
 * local Y.Doc with the same guid; applies the embedded snapshot for instant
 * content, then y-webrtc handles live sync. Registers the recipe in the
 * local index so it appears in the list.
 */
/**
 * Wait until the shared doc has content (title set) or timeout.
 * Without this, a fast join can register the recipe in the index before its
 * content arrives via sync — it would list but not open.
 */
async function waitForContent(doc: Y.Doc, timeoutMs: number): Promise<void> {
  const map = doc.getMap(RECIPE_MAP)
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (typeof map.get('title') === 'string') return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('Timed out waiting for the shared recipe to arrive.')
}

export async function joinShare(payload: SharePayload): Promise<void> {
  const repo = getRepo()
  const doc = await getOrCreateDoc(repo, payload.recipeId)
  // Fresh-GUID binding: a payload names the recipe id its content merges
  // into. If this device already has a NON-EMPTY doc under that id that
  // is not already this share's doc (no share record), refuse — merging
  // a stranger's snapshot/sync into an existing local recipe (e.g. one
  // the user authored, whose id a crafted payload can know from its
  // public record) is never what "join this share" should do.
  if (!getShare(payload.recipeId) && doc.getMap(RECIPE_MAP).size > 0) {
    throw new Error(
      'That share code points at a recipe you already have, outside this share. ' +
        'Nothing was changed. (If you meant to re-join, delete your local copy first, then join again.)',
    )
  }
  // Apply the embedded snapshot for instant content. y-webrtc then handles
  // live updates. Falls back to waiting for sync if no snapshot (old payloads).
  if (payload.snapshot) {
    Y.applyUpdate(doc, base64ToU8(payload.snapshot))
  }
  await joinRoom(payload.room, doc, payload.signaling, payload.secret)
  if (!payload.snapshot) {
    await waitForContent(doc, 20000)
  }
  await registerSharedRecipe(repo, payload.recipeId, payload.title)
  saveShare({
    recipeId: payload.recipeId,
    room: payload.room,
    signaling: payload.signaling,
    role: 'guest',
    ...(payload.secret ? { secret: payload.secret } : {}),
  })
}

/**
 * Rejoin every saved share on app launch. Peers rediscover each other through
 * signaling and Yjs sync converges — this is also the partition-healing path.
 */
export async function rejoinShares(): Promise<void> {
  const repo = getRepo()
  for (const s of loadShares()) {
    try {
      const doc = await getOrCreateDoc(repo, s.recipeId)
      await joinRoom(s.room, doc, s.signaling, s.secret)
    } catch (e) {
      console.warn('rejoin share failed', s.recipeId, e)
    }
  }
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

/** Parse and validate a pasted/scanned share payload. Throws on invalid. */
export function parseSharePayload(text: string): SharePayload {
  let obj: unknown
  try {
    obj = JSON.parse(text.trim())
  } catch {
    throw new Error('That code did not parse as a share invitation.')
  }
  const o = obj as Partial<SharePayload> | null
  if (
    typeof obj !== 'object' ||
    obj === null ||
    o?.v !== 1 ||
    typeof o.room !== 'string' ||
    !o.room ||
    typeof o.signaling !== 'string' ||
    !o.signaling ||
    typeof o.recipeId !== 'string' ||
    !o.recipeId ||
    typeof o.title !== 'string'
  ) {
    throw new Error('That code is not a valid Longtable share invitation.')
  }
  // The room is a pure function of the recipe id (roomForRecipe). A
  // payload whose room disagrees is forged or corrupted — accepting it
  // would join an attacker-chosen room under this recipe's id.
  if (o.room !== roomForRecipe(o.recipeId as string)) {
    throw new Error('That code is not a valid Longtable share invitation.')
  }
  // Snapshot, when present, must be well-formed base64 carrying a real
  // Yjs update (applied to a scratch doc here — the target doc is only
  // touched by joinShare after this validation passes).
  if (o.snapshot !== undefined) {
    if (
      typeof o.snapshot !== 'string' ||
      !o.snapshot ||
      o.snapshot.length % 4 !== 0 ||
      !BASE64_RE.test(o.snapshot)
    ) {
      throw new Error('That code is not a valid Longtable share invitation.')
    }
    const scratch = new Y.Doc()
    try {
      Y.applyUpdate(scratch, base64ToU8(o.snapshot))
    } catch {
      throw new Error('That code is not a valid Longtable share invitation.')
    } finally {
      scratch.destroy()
    }
  }
  if (
    o.secret !== undefined &&
    (typeof o.secret !== 'string' || !o.secret)
  ) {
    throw new Error('That code is not a valid Longtable share invitation.')
  }
  return obj as SharePayload
}
