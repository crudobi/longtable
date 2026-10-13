/**
 * Friends — Phase 2.
 *
 * A "friend" is a mutual, verified DID pairing between two devices:
 *
 *   1. One device shows a friend invite (QR / paste code) containing its DID,
 *      a one-time pairing room, and a random pair secret.
 *   2. Both devices join the pairing room and exchange signed "hello"s —
 *      each proves possession of its DID's secret key by signing the room
 *      name, so a copied DID alone can't impersonate anyone.
 *   3. Both persist a friend record and derive a persistent friend channel:
 *      a y-webrtc room whose name and password come from the pair secret
 *      (known only to the two devices, exchanged out-of-band in the invite).
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
  /** sha256 hex of the pair secret; basis for channel room/doc names. */
  pairId: string
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
  /** base64 detached signature over `longtable-pair:<room>:<did>`. */
  sig: string
}

const HELLO_MAP = 'pairing'

function helloMessage(room: string, did: string): Uint8Array {
  return utf8ToU8(`longtable-pair:${room}:${did}`)
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
  const doc = new Y.Doc()
  const provider = await connectEphemeral(invite.room, doc, invite.signaling)
  try {
    const sig = await signDetached(
      identity,
      helloMessage(invite.room, identity.did),
    )
    const mine: Hello = { did: identity.did, name: myName, sig: u8ToBase64(sig) }
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
          helloMessage(invite.room, hello.did),
          base64ToU8(hello.sig),
        )
        if (!ok) {
          throw new Error("Could not verify the other device's identity signature.")
        }
        const rec: FriendRecord = {
          did: hello.did,
          name: typeof hello.name === 'string' ? hello.name : '',
          pairSecret: invite.pairSecret,
          pairId: await pairIdFor(invite.pairSecret),
          signaling: invite.signaling,
          addedAt: new Date().toISOString(),
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

/** Local Y.Doc guid for a friend channel's shelf document. */
export function shelfGuidFor(friend: FriendRecord): string {
  return `shelf-${friend.pairId.slice(0, 32)}`
}

/** y-webrtc room for a friend channel. */
export function channelRoomFor(friend: FriendRecord): string {
  return `longtable-friend-${friend.pairId.slice(0, 32)}`
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
