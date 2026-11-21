/**
 * Friends — Phase 2.
 *
 * A "friend" is a mutual, verified DID pairing between two devices:
 *
 *   1. One device shows a friend invite (QR / paste code) containing its DID,
 *      a one-time pairing room, and a random pair secret.
 *   2. Both devices join the pairing room and exchange signed "hello"s —
 *      each proves possession of its DID's secret key by signing a hello
 *      that binds its DID, the room, and the pair secret's BLAKE2b-256
 *      hash (v2), so a copied DID — or a hello replayed from another
 *      pairing — can't impersonate anyone.
 *   3. Both persist a friend record and derive a persistent friend channel:
 *      a y-webrtc room whose password comes from the pair secret (known
 *      only to the two devices, exchanged out-of-band in the invite) and
 *      whose name/doc is bound to BOTH DIDs as well (channelTag, v2) — so
 *      two pairings on one reused invite land in different rooms with
 *      different shelf docs instead of collapsing into one shared channel
 *      (S8). Records made before this fix carry no channelTag and keep
 *      the legacy pairId-only derivation, so existing pairings work
 *      untouched; a new pairing against an older build negotiates down
 *      to the legacy derivation via the hello's channelVersion.
 *
 * No account, no email, no hub account: the hub is signaling-only, exactly
 * as in Phase 1. Friend records and the pair secret live in localStorage.
 */
import * as Y from 'yjs'
import sodium from 'libsodium-wrappers'
import {
  cryptoReady,
  signDetached,
  verifyDetached,
  type Identity,
  type KeyValueStore,
} from '../identity/identity'
import { base64ToU8, u8ToBase64, u8ToHex, utf8ToU8 } from '../identity/codec'
import { getOrCreateDoc, getRepo, type YjsStore } from '../store/repo'
import { getActiveHub, getIceServers, getSignalingUrls } from '../hubs/hubs'
import type { WebrtcProvider as WebrtcProviderType } from 'y-webrtc'

const FRIENDS_KEY = 'longtable:friends'

export interface FriendRecord {
  /** The friend's DID (did:key). */
  did: string
  /** Display name the friend announced during pairing. */
  name: string
  /** Base64 pair secret exchanged in the invite (channel name + password). */
  pairSecret: string
  /** BLAKE2b-256 hex of the pair secret; basis for channel room/doc names. */
  pairId: string
  /**
   * Symmetric channel tag (S8, v2): `<pairId prefix>-<hash(pairId + both
   * DIDs, sorted)>`, computed identically by both sides of the pairing.
   * Two pairings on one reused invite therefore get DIFFERENT rooms/docs
   * even though they share the pair secret — the guests never share a
   * shelf, a room password, or a shelf-doc guid. Absent = pre-fix record:
   * the legacy pairId-only derivation (compat path — existing pairings
   * keep working untouched).
   */
  channelTag?: string
  /** Signaling server both devices met on; channels rejoin through it. */
  signaling: string
  addedAt: string
}

export interface FriendInvitePayload {
  v: 2
  kind: 'friend'
  did: string
  name: string
  signaling: string
  /** One-time pairing room (y-webrtc topic). */
  room: string
  /** Base64 32-byte pair secret. Whoever holds the invite becomes the friend. */
  pairSecret: string
}

// ---------------------------------------------------------------------------
// Friend record storage
// ---------------------------------------------------------------------------

export function listFriends(kv: KeyValueStore = localStorage): FriendRecord[] {
  try {
    const raw = kv.getItem(FRIENDS_KEY)
    if (!raw) return []
    const arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (f): f is FriendRecord =>
        typeof f === 'object' &&
        f !== null &&
        typeof (f as FriendRecord).did === 'string' &&
        typeof (f as FriendRecord).pairSecret === 'string' &&
        typeof (f as FriendRecord).pairId === 'string',
    )
  } catch {
    return []
  }
}

export function getFriend(
  did: string,
  kv: KeyValueStore = localStorage,
): FriendRecord | undefined {
  return listFriends(kv).find((f) => f.did === did)
}

export function saveFriend(
  rec: FriendRecord,
  kv: KeyValueStore = localStorage,
): void {
  const friends = listFriends(kv).filter((f) => f.did !== rec.did)
  friends.push(rec)
  kv.setItem(FRIENDS_KEY, JSON.stringify(friends))
}

export function removeFriend(
  did: string,
  kv: KeyValueStore = localStorage,
): void {
  const friends = listFriends(kv).filter((f) => f.did !== did)
  kv.setItem(FRIENDS_KEY, JSON.stringify(friends))
}

// ---------------------------------------------------------------------------
// Invite payloads
// ---------------------------------------------------------------------------

/** Derive the stable pairId (BLAKE2b-256 hex) from a base64 pair secret. */
export async function pairIdFor(pairSecretB64: string): Promise<string> {
  await cryptoReady()
  // BLAKE2b-256 via crypto_generichash: crypto_hash_sha256 lives only in
  // the libsodium *sumo* wrappers build; the standard build (ours) omits it.
  return u8ToHex(sodium.crypto_generichash(32, base64ToU8(pairSecretB64), null))
}

export async function createFriendInvite(
  identity: Identity,
  name: string,
  signaling: string = getActiveHub().signalingUrl,
): Promise<FriendInvitePayload> {
  await cryptoReady()
  const room = `longtable-pair-${u8ToHex(sodium.randombytes_buf(8))}`
  const pairSecret = u8ToBase64(sodium.randombytes_buf(32))
  return { v: 2, kind: 'friend', did: identity.did, name, signaling, room, pairSecret }
}

/** Parse and validate a pasted/scanned friend invite. Throws on invalid. */
export function parseFriendInvite(text: string): FriendInvitePayload {
  let obj: unknown
  try {
    obj = JSON.parse(text.trim())
  } catch {
    throw new Error('That code did not parse as a friend invitation.')
  }
  const o = obj as Partial<FriendInvitePayload>
  if (
    typeof obj !== 'object' ||
    obj === null ||
    o.v !== 2 ||
    o.kind !== 'friend' ||
    typeof o.did !== 'string' ||
    !o.did.startsWith('did:key:z') ||
    typeof o.name !== 'string' ||
    typeof o.signaling !== 'string' ||
    !o.signaling ||
    typeof o.room !== 'string' ||
    !o.room.startsWith('longtable-pair-') ||
    typeof o.pairSecret !== 'string' ||
    !o.pairSecret
  ) {
    throw new Error('That code is not a valid Longtable friend invitation.')
  }
  return obj as FriendInvitePayload
}

// ---------------------------------------------------------------------------
// Pairing handshake (ephemeral Y.Doc in the one-time pairing room)
// ---------------------------------------------------------------------------

interface Hello {
  did: string
  name: string
  /** base64 detached signature over the v2 hello message (see helloMessage). */
  sig: string
  /**
   * Channel-derivation version this side supports (S8). 2 = DID-bound
   * rooms/docs. Absent = pre-fix build (legacy pairId-only derivation).
   * Advisory only — NOT covered by the hello signature, so a pairing-room
   * MITM could force a downgrade to the legacy derivation (exactly the
   * pre-fix behavior, no worse); it cannot forge a pairing.
   */
  channelVersion?: number
}

const HELLO_MAP = 'pairing'

/**
 * The exact bytes a pairing hello signs (v2):
 *   longtable-pair:v2:<room>:<did>:<pairId>
 * where pairId is the pair secret's BLAKE2b-256 hex (pairIdFor). The v1
 * message bound only room+did, so anyone who learned the room name (it
 * transits the signaling server in plaintext) could race the real guest
 * and get their own DID bound as the inviter's "friend". Under v2 a hello
 * also proves possession of the pair secret, which only the invite holder
 * has; a racer's hello cannot verify against the inviter's pairId.
 * Exported for unit tests.
 */
export function helloMessage(room: string, did: string, pairId: string): Uint8Array {
  return utf8ToU8(`longtable-pair:v2:${room}:${did}:${pairId}`)
}

async function connectEphemeral(
  room: string,
  doc: Y.Doc,
  signaling: string,
): Promise<WebrtcProviderType> {
  const { WebrtcProvider } = await import('y-webrtc')
  return new WebrtcProvider(room, doc, {
    // Rendezvous on the invite's signaling AND every configured hub, so
    // pairing succeeds as long as both sides share one live hub (Phase 4).
    signaling: getSignalingUrls(signaling),
    peerOpts: { config: { iceServers: getIceServers() } },
  })
}

/**
 * Run the pairing handshake for one side. `expectedPeerDid` pins the peer
 * (the guest scanned the inviter's DID, so it accepts only that DID); the
 * inviter passes null and accepts whoever shows up with the invite.
 * Resolves with the persisted friend record.
 */
export async function runPairing(
  identity: Identity,
  myName: string,
  invite: FriendInvitePayload,
  expectedPeerDid: string | null,
  kv: KeyValueStore = localStorage,
  timeoutMs = 90000,
): Promise<FriendRecord> {
  await cryptoReady()
  const pairId = await pairIdFor(invite.pairSecret)
  const doc = new Y.Doc()
  const provider = await connectEphemeral(invite.room, doc, invite.signaling)
  try {
    const sig = await signDetached(
      identity,
      helloMessage(invite.room, identity.did, pairId),
    )
    const mine: Hello = {
      did: identity.did,
      name: myName,
      sig: u8ToBase64(sig),
      // v2 channel binding (S8): this side derives DID-bound rooms/docs.
      channelVersion: 2,
    }
    doc.transact(() => {
      doc.getMap(HELLO_MAP).set(identity.did, JSON.stringify(mine))
    })

    const t0 = Date.now()
    for (;;) {
      const hellos: Hello[] = []
      doc.getMap(HELLO_MAP).forEach((raw, did) => {
        if (did === identity.did || typeof raw !== 'string') return
        try {
          const h = JSON.parse(raw) as Hello
          if (h && h.did === did && typeof h.sig === 'string') hellos.push(h)
        } catch {
          /* not a hello (yet) */
        }
      })
      const hello = hellos[0]
      if (hello) {
        if (expectedPeerDid && hello.did !== expectedPeerDid) {
          throw new Error('The device that answered is not the one on the invite.')
        }
        const ok = await verifyDetached(
          hello.did,
          helloMessage(invite.room, hello.did, pairId),
          base64ToU8(hello.sig),
        )
        if (!ok) {
          throw new Error("Could not verify the other device's identity signature.")
        }
        const rec: FriendRecord = {
          did: hello.did,
          name: typeof hello.name === 'string' ? hello.name : '',
          pairSecret: invite.pairSecret,
          pairId,
          signaling: invite.signaling,
          addedAt: new Date().toISOString(),
        }
        // v2 channel binding (S8): only when the peer advertised v2.
        // Both sides compute the same symmetric tag from the pair secret
        // and the two DIDs; an older peer sends no channelVersion and the
        // pairing stays on the legacy derivation, so mixed-version
        // pairings still connect (on the old, shared-room derivation).
        if (hello.channelVersion === 2) {
          rec.channelTag = channelTagFor(pairId, identity.did, hello.did)
        }
        saveFriend(rec, kv)
        return rec
      }
      if (Date.now() - t0 > timeoutMs) {
        throw new Error('Pairing timed out — the other device never answered.')
      }
      await new Promise((r) => setTimeout(r, 400))
    }
  } finally {
    provider.destroy()
    doc.destroy()
  }
}

// ---------------------------------------------------------------------------
// Friend channels (persistent per-pair shelf documents)
// ---------------------------------------------------------------------------

const channelProviders = new Map<string, WebrtcProviderType>()
const observedDocs = new Set<string>()
const channelListeners = new Set<(friendDid: string) => void>()

/**
 * FNV-1a-64 hex — same algorithm as hubs.ts legacyMatchHash, copied here
 * so friends.ts does not depend on a hub-migration helper. Synchronous
 * (channel derivation runs from sync record lookups, before libsodium
 * WASM init) and deterministic across engines. NOT a secrecy boundary:
 * room names transit the signaling server in plaintext; the room
 * password (pairSecret) is the secret. The hash only binds the room/doc
 * to the two DIDs.
 */
export function didBindingHash(value: string): string {
  let hash = BigInt('0xcbf29ce484222325')
  const bytes = new TextEncoder().encode(value)
  for (const b of bytes) {
    hash ^= BigInt(b)
    hash = (hash * BigInt('0x100000001b3')) & BigInt('0xffffffffffffffff')
  }
  return hash.toString(16).padStart(16, '0')
}

/**
 * Symmetric channel tag for one pairing (S8): identical on both sides,
 * different for every other DID pair. The two DIDs are sorted so the
 * inviter and the guest compute the same tag from the same pair secret.
 * Two pairings on one reused invite therefore land in different rooms
 * with different shelf docs, even though they share the pair secret.
 */
export function channelTagFor(pairId: string, didA: string, didB: string): string {
  const [lo, hi] = didA < didB ? [didA, didB] : [didB, didA]
  return `${pairId.slice(0, 32)}-${didBindingHash(`${pairId}:${lo}:${hi}`)}`
}

/** Local Y.Doc guid for a friend channel's shelf document. */
export function shelfGuidFor(friend: FriendRecord): string {
  // v2 (channelTag present): DID-bound doc. Legacy (absent): the
  // pairId-only doc — existing pairings keep working untouched.
  return `shelf-${friend.channelTag ?? friend.pairId.slice(0, 32)}`
}

/** y-webrtc room for a friend channel. */
export function channelRoomFor(friend: FriendRecord): string {
  return `longtable-friend-${friend.channelTag ?? friend.pairId.slice(0, 32)}`
}

/** Subscribe to shelf-doc updates for any friend channel. */
export function onChannelUpdate(cb: (friendDid: string) => void): () => void {
  channelListeners.add(cb)
  return () => {
    channelListeners.delete(cb)
  }
}

function notifyChannel(friendDid: string): void {
  for (const cb of channelListeners) {
    try {
      cb(friendDid)
    } catch (e) {
      console.warn('channel update listener failed', e)
    }
  }
}

/**
 * Join (or rejoin) the friend channel for `friend`: loads the persisted
 * shelf doc and connects its y-webrtc provider. Idempotent.
 */
export async function joinFriendChannel(
  friend: FriendRecord,
  repo: YjsStore = getRepo(),
): Promise<Y.Doc> {
  const doc = await getOrCreateDoc(repo, shelfGuidFor(friend))
  if (!observedDocs.has(doc.guid)) {
    observedDocs.add(doc.guid)
    doc.on('update', () => notifyChannel(friend.did))
  }
  if (!channelProviders.has(friend.did)) {
    const { WebrtcProvider } = await import('y-webrtc')
    const provider = new WebrtcProvider(channelRoomFor(friend), doc, {
      // The friend's recorded signaling first, then every configured hub:
      // the channel re-rendezvous on any live hub after a hub death.
      signaling: getSignalingUrls(friend.signaling),
      password: friend.pairSecret,
      peerOpts: { config: { iceServers: getIceServers() } },
    })
    channelProviders.set(friend.did, provider)
  }
  return doc
}

/** The shelf doc for a friend (joining the channel if needed). */
export async function getChannelDoc(
  friend: FriendRecord,
  repo: YjsStore = getRepo(),
): Promise<Y.Doc> {
  return joinFriendChannel(friend, repo)
}

/** Stop syncing with a friend (used on unfriend). Local data is kept. */
export function disconnectFriendChannel(friendDid: string): void {
  const provider = channelProviders.get(friendDid)
  if (provider) {
    provider.destroy()
    channelProviders.delete(friendDid)
  }
}

/**
 * Destroy every friend-channel provider (hub switch). Channels rejoin via
 * rejoinFriendChannels against the new hub's endpoints. Local data is kept.
 */
export function disconnectAllFriendChannels(): void {
  for (const did of [...channelProviders.keys()]) {
    disconnectFriendChannel(did)
  }
}

/** Rejoin every saved friend's channel (app launch). */
export async function rejoinFriendChannels(
  kv: KeyValueStore = localStorage,
  repo: YjsStore = getRepo(),
): Promise<void> {
  for (const friend of listFriends(kv)) {
    try {
      await joinFriendChannel(friend, repo)
    } catch (e) {
      console.warn('rejoin friend channel failed', friend.did, e)
    }
  }
}
