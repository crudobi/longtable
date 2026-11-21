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
 * Shares persist in the secure store (Keystore on Android, localStorage
 * on web — see src/secrets/secretStore.ts) and are rejoined on every
 * launch, so peers reconnect after app restarts (this is also what
 * heals a partition). Share records carry the room secret, so they are
 * crown-jewel secrets, not plain preferences.
 * A share ends only through leaveShare(), which destroys the provider and
 * deletes the record — deleting the recipe or narrowing its visibility
 * without leaving would resurrect the room on the next launch.
 */
import * as Y from 'yjs'
import { getOrCreateDoc, getRepo } from '../store/repo'
import type { KeyValueStore } from '../identity/identity'
import { getOrCreateIndex, RECIPE_LIMITS, RECIPE_MAP, registerSharedRecipe } from '../store/recipes'
import { DEFAULT_HUB, getActiveHub, getIceServers, getSignalingUrls } from '../hubs/hubs'
import { secretKv } from '../secrets/secretStore'
import {
  CorruptStoreError,
  assertStoreWritable,
  noteCorruptStore,
  readStoredJson,
} from '../store/corrupt'

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
export const SHARES_KEY = 'longtable:shares'

/** ICE servers for the built-in default hub (compat export; live code uses
 * `getIceServers()` from the hub registry so the ACTIVE hub supplies TURN.
 * Any TURN credential comes from the registry / build-time injection —
 * never from a source constant). */
export const ICE_SERVERS: RTCIceServer[] = getIceServers(DEFAULT_HUB)

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
  /**
   * Set when this share upgraded a legacy (pre-auth, passwordless) share:
   * the secret is fresh, so guests holding the old code can no longer sync
   * and need this new code. Surfaced so the UI can say so at share time.
   * Not part of the invitation itself; joiners ignore it.
   */
  upgradedFromLegacy?: boolean
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

/**
 * Validate the content of a shared recipe doc before it is registered
 * (S9). A share snapshot is unauthenticated bytes from a QR code or a
 * pasted string: a crafted code could carry a non-string title, huge
 * arrays, or thousands of photos that would otherwise be persisted into
 * IndexedDB and handed straight to the render path. Returns the title to
 * list (trimmed, capped at RECIPE_LIMITS.titleChars, matching the
 * importer and store caps). Throws on anything that cannot be safely
 * listed; an over-long title alone is truncated, not refused, so a
 * pre-fix recipe with a long title still joins.
 */
export function validateSharedDoc(doc: Y.Doc): string {
  const map = doc.getMap(RECIPE_MAP)
  const title = map.get('title')
  if (typeof title !== 'string' || !title.trim()) {
    throw new Error('That share code does not contain a readable recipe.')
  }
  const checkList = (key: string, max: number): void => {
    const value = map.get(key)
    if (value === undefined) return
    if (!(value instanceof Y.Array)) {
      throw new Error(`That share code has a malformed ${key} list.`)
    }
    if (value.length > max) {
      throw new Error(`That share code has too many ${key} entries (${value.length}).`)
    }
    for (const item of value.toArray()) {
      if (typeof item !== 'string' || item.length > RECIPE_LIMITS.itemChars) {
        throw new Error(`That share code has a malformed ${key} entry.`)
      }
    }
  }
  checkList('ingredients', RECIPE_LIMITS.listItems)
  checkList('steps', RECIPE_LIMITS.listItems)
  checkList('photos', RECIPE_LIMITS.photos)
  return title.trim().slice(0, RECIPE_LIMITS.titleChars)
}

/**
 * Load the saved share records (H9). Absent reads as empty; corrupt
 * JSON — or a top-level value that is not an array — is quarantined
 * (bytes preserved, see src/store/corrupt.ts) and reads as empty.
 * Records that fail the shape check are dropped individually: one bad
 * record never wipes the other shares. Exported for App's startup
 * corruption probe (the app's live store is the secure store).
 */
export function loadShares(): ShareRecord[] {
  return listShares(secretKv)
}

/**
 * Key/value-parameterized share-record access (Wave 3 C3: the encrypted
 * backup reads/writes share records through an injectable store instead
 * of the app's global localStorage). Same key, same shape, same
 * validation-light parse as loadShares; in the app `kv` IS localStorage,
 * so both paths see the same records. Records that fail the shape check
 * are dropped, never trusted.
 */
export function listShares(kv: KeyValueStore = localStorage): ShareRecord[] {
  const read = readStoredJson(kv, SHARES_KEY)
  if (read.status === 'absent') return []
  if (read.status === 'corrupt') return []
  if (!Array.isArray(read.value)) {
    noteCorruptStore(kv, SHARES_KEY, read.raw, 'not a JSON array')
    return []
  }
  return (read.value as ShareRecord[]).filter(
    (s): s is ShareRecord =>
      typeof s === 'object' &&
      s !== null &&
      typeof (s as ShareRecord).recipeId === 'string' &&
      typeof (s as ShareRecord).room === 'string' &&
      typeof (s as ShareRecord).signaling === 'string' &&
      ((s as ShareRecord).role === 'host' || (s as ShareRecord).role === 'guest'),
  )
}

/**
 * Replace the whole saved share-record list (backup restore). Refuses
 * (throws CorruptStoreError) when the stored list is corrupt: a
 * restore that saved over the damaged bytes would drop every other
 * share. Backup restore clears the corruption record first — it is
 * the deliberate replacement path.
 */
export function saveShares(kv: KeyValueStore, shares: ShareRecord[]): void {
  assertStoreWritable(SHARES_KEY)
  kv.setItem(SHARES_KEY, JSON.stringify(shares))
}

function saveShare(rec: ShareRecord): void {
  const shares = loadShares().filter((s) => s.recipeId !== rec.recipeId)
  shares.push(rec)
  // H9: refuse to persist over a corrupt share list (throws
  // CorruptStoreError — NOT swallowed by the storage catch below, so
  // joining a share can never silently drop the other shares' records).
  assertStoreWritable(SHARES_KEY)
  try {
    secretKv.setItem(SHARES_KEY, JSON.stringify(shares))
  } catch {
    /* storage full or unavailable — sharing still works for this session */
  }
}

/**
 * Remove the saved share record for a recipe, if one exists. When the
 * stored list is corrupt the record is unreadable anyway and the room
 * is already dead (leaveShare destroys the provider first), so the
 * refusal is logged, not thrown — leaveShare never throws for a
 * missing share, and the corrupt bytes stay preserved.
 */
function deleteShareRecord(recipeId: string): void {
  const shares = loadShares().filter((s) => s.recipeId !== recipeId)
  try {
    assertStoreWritable(SHARES_KEY)
    secretKv.setItem(SHARES_KEY, JSON.stringify(shares))
  } catch (e) {
    if (e instanceof CorruptStoreError) {
      console.warn(
        'share record not removed: the saved share list is damaged — ' +
          'restore from an encrypted backup to recover it',
      )
      return
    }
    /* storage unavailable — the provider is already dead (leaveShare
       destroys it before this runs), and rejoinShares re-reads storage,
       so a record that cannot be removed here can only come back if
       storage starts working again with the stale record still in it */
  }
}

/** The saved share for a recipe, if this device shares or joined it. */
export function getShare(recipeId: string): ShareRecord | undefined {
  return loadShares().find((s) => s.recipeId === recipeId)
}

/**
 * Whether this device currently has a live provider for the recipe's
 * room. Introspection for tests and debug UI — the behavioral proof is
 * always "no further updates flow", never this flag alone.
 */
export function hasShareProvider(recipeId: string): boolean {
  return providers.has(roomForRecipe(recipeId))
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
 * Stop sharing a recipe (H1/H7 + H-N2): destroy this device's room
 * provider, detach the share-update listener the provider attached to
 * the doc, and delete the saved share record — so rejoinShares can never
 * resurrect the room on the next launch, and no further local edits
 * reach (ex-)guests.
 *
 * The recipe doc itself is untouched: the recipe stays on this device
 * (a visibility flip or "Stop sharing" must not delete the user's
 * recipe). Deleting the recipe as well is performDeleteFlow's job, which
 * calls this first and then wipes the doc.
 *
 * Idempotent and total: leaving a recipe that was never shared, or
 * leaving twice, is a no-op. Never throws for a missing share; provider
 * teardown is best-effort (destroy() on a live provider does not throw,
 * and a dead one is already gone).
 */
export function leaveShare(recipeId: string): void {
  const room = roomForRecipe(recipeId)
  const p = providers.get(room)
  if (p) {
    try {
      p.destroy()
    } catch {
      /* already gone */
    }
    providers.delete(room)
  }
  // The provider attached this listener to the doc in joinRoom; drop it
  // so a left share stops triggering UI refreshes on local edits. Only
  // when the doc is already loaded — an unloaded doc never had one.
  const cached = getRepo().docs.get(recipeId)
  if (cached) {
    try {
      cached.doc.off('update', notifyUpdate)
    } catch {
      /* ignore */
    }
  }
  deleteShareRecord(recipeId)
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
  // given the new code to keep syncing. That upgrade is surfaced to the
  // caller (upgradedFromLegacy on the payload) so the UI can say so at
  // share time instead of silently stranding the old guests.
  const existing = getShare(recipeId)
  const secret = existing?.secret ?? newShareSecret()
  const upgradedFromLegacy =
    existing !== undefined && existing.secret === undefined
  await joinRoom(room, doc, signaling, secret)
  saveShare({ recipeId, room, signaling, role: 'host', secret })
  // Embed a snapshot so the guest gets content instantly, even if y-webrtc
  // hasn't synced yet. y-webrtc handles live updates after the join.
  const snapshot = u8ToBase64(Y.encodeStateAsUpdate(doc))
  return {
    v: 1 as const,
    room,
    signaling,
    recipeId,
    title,
    snapshot,
    secret,
    ...(upgradedFromLegacy ? { upgradedFromLegacy: true as const } : {}),
  }
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
  // Content validation (S9): the snapshot / synced content is
  // unauthenticated bytes. Validate shape + caps before registering — a
  // failure leaves the recipe unlisted and saves no share record. (When
  // the payload came through parseSharePayload its snapshot was already
  // validated on a scratch doc; this covers the no-snapshot path and
  // programmatic callers that skip parsing.) The VALIDATED doc title is
  // registered — not payload.title, which used to be trusted verbatim.
  const title = validateSharedDoc(doc)
  await registerSharedRecipe(repo, payload.recipeId, title)
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
  // Orphan cleanup (H1/H7): a share record whose recipe is no longer in
  // the index is a leftover of a delete that predates leaveShare (or of
  // a delete path that bypassed it). Rejoining it would resurrect the doc
  // and keep the room syncing, unlisted, forever — so tear the share
  // down (leaveShare) instead of joining. Records are only written after
  // the recipe is
  // registered in the index (joinShare) or created there (shareRecipe),
  // so a missing entry is never a live share. If the index itself cannot
  // be read, rejoin everything (today's behavior) rather than dropping
  // shares on a transient failure.
  let indexed: Set<string> | null = null
  try {
    const snap = await (await getOrCreateIndex(repo)).doc()
    indexed = new Set(Object.keys(snap?.recipes ?? {}))
  } catch (e) {
    console.warn('rejoin shares: index unreadable, rejoining all', e)
  }
  for (const s of loadShares()) {
    if (indexed !== null && !indexed.has(s.recipeId)) {
      // Full teardown, not just a record delete: a provider for this
      // room may already be live in this session (e.g. the share was
      // joined, then the recipe deleted without leaving). Leaving it
      // would keep the room syncing with a doc that no longer exists.
      leaveShare(s.recipeId)
      continue
    }
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
      // Content validation (S9): the snapshot is unauthenticated bytes —
      // reject unbounded/malformed recipe content here, on the scratch
      // doc, before joinShare ever touches the real doc (and its
      // IndexedDB persistence).
      validateSharedDoc(scratch)
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
