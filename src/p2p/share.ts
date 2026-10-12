/**
 * P2P sharing via y-webrtc. One room per shared recipe; the signaling server
 * only routes WebRTC handshake messages and never sees recipe content.
 *
 * Flow:
 *   host:  shareRecipe(id) -> QR payload -> guest scans/pastes
 *   guest: joinShare(payload) -> empty Y.Doc with the SAME guid -> y-webrtc
 *          sync populates it from the host -> registered in the guest's index
 *
 * Shares persist in localStorage and are rejoined on every launch, so peers
 * reconnect after app restarts (this is also what heals a partition).
 */
import * as Y from 'yjs'
import { WebrtcProvider } from 'y-webrtc'
import { getOrCreateDoc, getRepo } from '../store/repo'
import { registerSharedRecipe } from '../store/recipes'

/**
 * Default signaling server (wss:// — the app's https://localhost WebView blocks
 * insecure ws://). Phase 1 dev points at devbox (reachable from the
 * emulator as 10.0.2.2). Production: the hub's wss:// URL.
 */
export const DEFAULT_SIGNALING_URL = 'wss://10.0.2.2:4444'

const SHARES_KEY = 'longtable:shares'

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
}

export interface ShareRecord {
  recipeId: string
  room: string
  signaling: string
  role: 'host' | 'guest'
}

const providers = new Map<string, WebrtcProvider>()

/** Callbacks fired when any shared doc updates (local or remote edit). */
const updateListeners = new Set<() => void>()

/**
 * Subscribe to shared-doc updates. The app uses this to refresh the list and
 * the open detail view when a friend's edit arrives. Returns an unsubscribe.
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
  const p = providers.get(room)
  if (!p) return 0
  return Math.max(0, p.awareness.getStates().size - 1)
}

async function joinRoom(
  room: string,
  doc: Y.Doc,
  signaling: string,
): Promise<WebrtcProvider> {
  let p = providers.get(room)
  if (!p) {
    p = new WebrtcProvider(room, doc, { signaling: [signaling] })
    providers.set(room, p)
    doc.on('update', notifyUpdate)
  }
  return p
}

/**
 * Host side: start sharing one of my recipes. Idempotent — calling twice
 * returns the same room. The returned payload is what goes in the QR code.
 */
export async function shareRecipe(
  recipeId: string,
  title: string,
  signaling: string = DEFAULT_SIGNALING_URL,
): Promise<SharePayload> {
  const repo = getRepo()
  const doc = await getOrCreateDoc(repo, recipeId)
  const room = roomForRecipe(recipeId)
  await joinRoom(room, doc, signaling)
  saveShare({ recipeId, room, signaling, role: 'host' })
  return { v: 1, room, signaling, recipeId, title }
}

/**
 * Guest side: join a share from a scanned or pasted payload. Creates the
 * local Y.Doc with the same guid; y-webrtc sync fills in the content.
 * Registers the recipe in the local index so it appears in the list.
 */
export async function joinShare(payload: SharePayload): Promise<void> {
  const repo = getRepo()
  const doc = await getOrCreateDoc(repo, payload.recipeId)
  await joinRoom(payload.room, doc, payload.signaling)
  await registerSharedRecipe(repo, payload.recipeId, payload.title)
  saveShare({
    recipeId: payload.recipeId,
    room: payload.room,
    signaling: payload.signaling,
    role: 'guest',
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
      await joinRoom(s.room, doc, s.signaling)
    } catch (e) {
      console.warn('rejoin share failed', s.recipeId, e)
    }
  }
}

/** Parse and validate a pasted/scanned share payload. Throws on invalid. */
export function parseSharePayload(text: string): SharePayload {
  let obj: unknown
  try {
    obj = JSON.parse(text.trim())
  } catch {
    throw new Error('That code did not parse as a share invitation.')
  }
  if (
    typeof obj !== 'object' ||
    obj === null ||
    (obj as { v?: unknown }).v !== 1 ||
    typeof (obj as { room?: unknown }).room !== 'string' ||
    !(obj as { room?: unknown }).room ||
    typeof (obj as { signaling?: unknown }).signaling !== 'string' ||
    !(obj as { signaling?: unknown }).signaling ||
    typeof (obj as { recipeId?: unknown }).recipeId !== 'string' ||
    !(obj as { recipeId?: unknown }).recipeId ||
    typeof (obj as { title?: unknown }).title !== 'string'
  ) {
    throw new Error('That code is not a valid Longtable share invitation.')
  }
  return obj as SharePayload
}
