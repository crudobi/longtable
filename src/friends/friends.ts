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
 * as in Phase 1. Friend records and the pair secret live in the Android
 * Keystore (src/secrets/secretStore.ts) on native, in localStorage on web.
 *
 * Hub-less pairing (E3, PLAN.md §2/§4.0): when no hub is reachable the
 * same handshake runs over a direct RTCPeerConnection whose SDP is
 * exchanged by hand — see manualSdp.ts. The transport changes; the
 * hello, its verification, the channel binding, and the single-use
 * enforcement do not: all three live here and both paths call them.
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
import { flushSecrets, secretKv } from '../secrets/secretStore'
import {
  assertStoreWritable,
  noteCorruptStore,
  readStoredJson,
} from '../store/corrupt'
import { base64ToU8, u8ToBase64, u8ToHex, utf8ToU8 } from '../identity/codec'
import { getOrCreateDoc, getRepo, type YjsStore } from '../store/repo'
import { getActiveHub, getIceServers, getSignalingUrls } from '../hubs/hubs'
import type { WebrtcProvider as WebrtcProviderType } from 'y-webrtc'

export const FRIENDS_KEY = 'longtable:friends'

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
  /** ISO timestamp the invite was minted (M2: invites expire). */
  createdAt?: string
  /** ISO timestamp after which the invite must not be accepted (M2). */
  expiresAt?: string
}

/** Invite lifetime (M2): an invite is a bearer credential, so it gets an expiry. */
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Secret validation (M8)
// ---------------------------------------------------------------------------

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * A pair secret must be strict base64 decoding to exactly 32 bytes —
 * the size every consumer (pairId hash, y-webrtc room password) assumes.
 * atob alone is too lenient (it ignores some invalid input and happily
 * decodes short strings), so the shape is checked first. Throws on
 * anything else. Checked at the parse and pairing boundaries; the
 * friend-record store itself does not reject legacy records, which
 * fail here at use time instead.
 */
export function validatePairSecret(secretB64: unknown): void {
  if (
    typeof secretB64 !== 'string' ||
    !secretB64 ||
    secretB64.length % 4 !== 0 ||
    !BASE64_RE.test(secretB64)
  ) {
    throw new Error('That invite code has a malformed pair secret.')
  }
  let bytes: Uint8Array
  try {
    bytes = base64ToU8(secretB64)
  } catch {
    throw new Error('That invite code has a malformed pair secret.')
  }
  if (bytes.length !== 32) {
    throw new Error('That invite code has a pair secret of the wrong length.')
  }
}

// ---------------------------------------------------------------------------
// Used invites (M2 — single-use enforcement)
// ---------------------------------------------------------------------------

/**
 * Used-invite store (M2). An invite is a bearer credential: once it has
 * paired one guest, a second guest holding the same code must not be
 * able to pair with it. The store records the invite fingerprint
 * (pairId + room — never the secret itself) with the peer it paired.
 *
 * Honest limit (documented, not hidden): enforcement is per-device —
 * the inviter's runPairing refuses a second pairing on a used invite,
 * and the guest's refuses to re-pair on one it already used. A wiped
 * device loses its used-invite store, and a malicious inviter can
 * always mint a fresh invite; what single-use closes is the accidental
 * and the replayed-code case, where a copied QR/paste keeps working
 * forever. Full single-use would also require evicting a second guest
 * who already holds the pairSecret — impossible without rotating the
 * channel password, which would evict the first guest too — so the
 * Wave 1 S8 per-DID channel binding remains the backstop: two guests
 * on one invite still land in separate rooms/shelves and cannot see
 * each other's shares.
 */
export interface UsedInvite {
  pairId: string
  room: string
  peerDid: string
  usedAt: string
}

const USED_INVITES_KEY = 'longtable:used-invites:v1'

export function loadUsedInvites(
  kv: KeyValueStore = secretKv,
): UsedInvite[] {
  try {
    const raw = kv.getItem(USED_INVITES_KEY)
    if (!raw) return []
    const arr: unknown = JSON.parse(raw)
    return Array.isArray(arr) ? (arr as UsedInvite[]) : []
  } catch {
    return []
  }
}

function saveUsedInvites(invites: UsedInvite[], kv: KeyValueStore): void {
  kv.setItem(USED_INVITES_KEY, JSON.stringify(invites))
}

export function isInviteUsed(
  pairId: string,
  room: string,
  kv: KeyValueStore = secretKv,
): boolean {
  return loadUsedInvites(kv).some((u) => u.pairId === pairId && u.room === room)
}

export function markInviteUsed(
  pairId: string,
  room: string,
  peerDid: string,
  kv: KeyValueStore = secretKv,
): void {
  const invites = loadUsedInvites(kv)
  if (invites.some((u) => u.pairId === pairId && u.room === room)) return
  invites.push({ pairId, room, peerDid, usedAt: new Date().toISOString() })
  saveUsedInvites(invites, kv)
}

// ---------------------------------------------------------------------------
// Friend record storage
// ---------------------------------------------------------------------------

/**
 * Load the friend list (H9). Absent reads as empty; corrupt JSON — or
 * a top-level value that is not an array — is quarantined (bytes
 * preserved, see src/store/corrupt.ts) and reads as empty. Entries
 * that fail the shape check are dropped individually: one bad record
 * never wipes the other friends.
 */
export function listFriends(kv: KeyValueStore = secretKv): FriendRecord[] {
  const read = readStoredJson(kv, FRIENDS_KEY)
  if (read.status === 'absent') return []
  if (read.status === 'corrupt') return []
  if (!Array.isArray(read.value)) {
    noteCorruptStore(kv, FRIENDS_KEY, read.raw, 'not a JSON array')
    return []
  }
  return (read.value as unknown[]).filter(
    (f): f is FriendRecord =>
      typeof f === 'object' &&
      f !== null &&
      typeof (f as FriendRecord).did === 'string' &&
      typeof (f as FriendRecord).pairSecret === 'string' &&
      typeof (f as FriendRecord).pairId === 'string',
  )
}

/**
 * Persist a friend list. Refuses (throws CorruptStoreError) when the
 * stored list is corrupt: a pairing that saved over the damaged bytes
 * would silently drop every existing friend. Backup restore clears
 * the corruption record first — it is the deliberate replacement path.
 *
 * Exported for the backup restore, which replaces the whole list in
 * one write: unlike saveFriend it does NOT re-load first, so a
 * restore can replace a damaged list after clearing the record
 * (saveFriend's load would re-detect the still-damaged bytes and
 * refuse). Any other caller must read through listFriends first.
 */
export function saveFriendsList(friends: FriendRecord[], kv: KeyValueStore): void {
  assertStoreWritable(FRIENDS_KEY)
  kv.setItem(FRIENDS_KEY, JSON.stringify(friends))
}

export function getFriend(
  did: string,
  kv: KeyValueStore = secretKv,
): FriendRecord | undefined {
  return listFriends(kv).find((f) => f.did === did)
}

export function saveFriend(
  rec: FriendRecord,
  kv: KeyValueStore = secretKv,
): void {
  const friends = listFriends(kv).filter((f) => f.did !== rec.did)
  friends.push(rec)
  saveFriendsList(friends, kv)
}

export function removeFriend(
  did: string,
  kv: KeyValueStore = secretKv,
): void {
  const friends = listFriends(kv).filter((f) => f.did !== did)
  saveFriendsList(friends, kv)
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
  const createdAt = new Date().toISOString()
  return {
    v: 2,
    kind: 'friend',
    did: identity.did,
    name,
    signaling,
    room,
    pairSecret,
    createdAt,
    // M2: an invite is a bearer credential — it expires.
    expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
  }
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
  // M8: the pair secret must be a strict 32-byte base64 value.
  try {
    validatePairSecret(o.pairSecret)
  } catch {
    throw new Error('That code is not a valid Longtable friend invitation.')
  }
  // M2: invites expire. Minted-before-expiry invites carry no timestamps
  // and stay accepted (compat); anything carrying an expiry is enforced.
  if (o.expiresAt !== undefined) {
    const exp = Date.parse(o.expiresAt)
    if (!Number.isFinite(exp)) {
      throw new Error('That code is not a valid Longtable friend invitation.')
    }
    if (Date.now() > exp) {
      throw new Error(
        'That invite code has expired — ask your friend to show a fresh invite code.',
      )
    }
  }
  if (o.createdAt !== undefined && !Number.isFinite(Date.parse(o.createdAt))) {
    throw new Error('That code is not a valid Longtable friend invitation.')
  }
  return obj as FriendInvitePayload
}

// ---------------------------------------------------------------------------
// Pairing handshake (ephemeral Y.Doc in the one-time pairing room)
// ---------------------------------------------------------------------------

export interface Hello {
  did: string
  name: string
  /** base64 detached signature over the v2 hello message (see helloMessage). */
  sig: string
  /**
   * Base64 detached signature binding the announced display name to
   * this pairing (M3): over helloNameMessage(room, did, pairId, name).
   * A v2 peer (channelVersion 2) MUST send a valid nameSig — its name
   * is then bound to its DID and cannot be swapped after the fact. A
   * pre-fix peer sends none and its name stays unbound (compat).
   */
  nameSig?: string
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

/**
 * The exact bytes a pairing hello's name signature covers (M3, v3):
 *   longtable-pair:v3:name:<room>:<did>:<pairId>:<name>
 * The display name a friend record stores is the name this signature
 * vouches for — a hello whose name was swapped after signing (or whose
 * name never was signed) is not accepted from a v2 peer.
 * Exported for unit tests.
 */
export function helloNameMessage(
  room: string,
  did: string,
  pairId: string,
  name: string,
): Uint8Array {
  return utf8ToU8(`longtable-pair:v3:name:${room}:${did}:${pairId}:${name}`)
}

// ---------------------------------------------------------------------------
// Shared hello build / verify / finalize (E3)
// ---------------------------------------------------------------------------
//
// The signaling path (runPairing, below) and the manual-SDP fallback
// (manualSdp.ts) are two transports for ONE pairing: the same hello,
// the same verification, the same friend record. These three helpers
// are the shared core, so a fix to verification can never land on one
// path and miss the other. Neither transport invents its own.

export interface VerifyHelloContext {
  room: string
  pairId: string
  expectedPeerDid: string | null
  expectedPeerName?: string | null
}

export type VerifyHelloResult =
  | { ok: true; did: string; name: string; channelVersion?: number }
  | { ok: false; reason: string }

/** Build my own hello: v2 signature over room+did+pairId, plus the M3 name signature. */
export async function buildMyHello(
  identity: Identity,
  myName: string,
  room: string,
  pairId: string,
): Promise<Hello> {
  const sig = await signDetached(
    identity,
    helloMessage(room, identity.did, pairId),
  )
  // M3: sign my own display name into the hello as well.
  const nameSig = await signDetached(
    identity,
    helloNameMessage(room, identity.did, pairId, myName),
  )
  return {
    did: identity.did,
    name: myName,
    sig: u8ToBase64(sig),
    nameSig: u8ToBase64(nameSig),
    // v2 channel binding (S8): this side derives DID-bound rooms/docs.
    channelVersion: 2,
  }
}

/**
 * Judge one peer hello. Returns the verified peer (did, bound name,
 * channel version) or a reason — never throws for a bad hello, so the
 * caller can skip it and keep waiting (M4). Checks, in order: the
 * expected DID (a racer, or the wrong guest), the expected name (M3),
 * the v2 hello signature (proves possession of the pair secret), and
 * for a v2 peer the signed display name (a swapped name is rejected).
 */
export async function verifyPeerHello(
  hello: Hello,
  ctx: VerifyHelloContext,
): Promise<VerifyHelloResult> {
  // Wrong device: a racer, or the wrong guest — keep waiting for the
  // expected one (M4: skip, never throw mid-pairing).
  if (ctx.expectedPeerDid && hello.did !== ctx.expectedPeerDid) {
    return { ok: false, reason: 'unexpected peer DID' }
  }
  // M3: the guest knows the name on the invite they scanned.
  if (ctx.expectedPeerName != null && hello.name !== ctx.expectedPeerName) {
    return { ok: false, reason: 'unexpected peer name' }
  }
  // A malformed signature (bad base64, wrong length) verifies as
  // false, never throws — the caller skips it like any bad hello.
  const verifies = async (
    did: string,
    msg: Uint8Array,
    sigB64: string,
  ): Promise<boolean> => {
    try {
      return await verifyDetached(did, msg, base64ToU8(sigB64))
    } catch {
      return false
    }
  }
  if (
    !(await verifies(
      hello.did,
      helloMessage(ctx.room, hello.did, ctx.pairId),
      hello.sig,
    ))
  ) {
    return { ok: false, reason: 'hello signature does not verify' }
  }
  // M3: a v2 peer's display name must be signed. An unsigned or
  // mis-signed name from a v2 peer is a swapped name — skip it.
  if (hello.channelVersion === 2) {
    if (typeof hello.name !== 'string' || typeof hello.nameSig !== 'string') {
      return { ok: false, reason: 'v2 peer sent no signed name' }
    }
    if (
      !(await verifies(
        hello.did,
        helloNameMessage(ctx.room, hello.did, ctx.pairId, hello.name),
        hello.nameSig,
      ))
    ) {
      return { ok: false, reason: 'name signature does not verify' }
    }
  }
  return {
    ok: true,
    did: hello.did,
    name: typeof hello.name === 'string' ? hello.name : '',
    channelVersion: hello.channelVersion,
  }
}

/**
 * Persist a verified peer as a friend record. The v2 channel binding
 * (S8) applies only when the peer advertised v2: both sides compute
 * the same symmetric tag from the pair secret and the two DIDs; an
 * older peer sends no channelVersion and the pairing stays on the
 * legacy derivation, so mixed-version pairings still connect (on the
 * old, shared-room derivation). The friend record carries the pair
 * secret, so the Keystore flush is awaited before returning — the
 * pairing must survive a kill right after it completes. M2: in
 * single-use mode this invite is spent now.
 */
export async function finalizePairing(
  peer: { did: string; name: string; channelVersion?: number },
  invite: FriendInvitePayload,
  pairId: string,
  myDid: string,
  kv: KeyValueStore = secretKv,
  opts: RunPairingOptions = {},
): Promise<FriendRecord> {
  const rec: FriendRecord = {
    did: peer.did,
    name: peer.name,
    pairSecret: invite.pairSecret,
    pairId,
    signaling: invite.signaling,
    addedAt: new Date().toISOString(),
  }
  if (peer.channelVersion === 2) {
    rec.channelTag = channelTagFor(pairId, myDid, peer.did)
  }
  saveFriend(rec, kv)
  await flushSecrets()
  if (opts.singleUse) markInviteUsed(pairId, invite.room, peer.did, kv)
  return rec
}

// y-webrtc is lazy-loaded on first use (it pulls in WebRTC shims that
// we do not want in the initial bundle — same reason as share.ts) — but
// the import must execute EXACTLY ONCE. Two concurrent dynamic imports
// of the same module race in the test runner: one caller can resolve to
// the REAL module instead of the vi.mock factory (S8 flake root cause,
// 2026-11-21 — reproduced with a minimal probe: 3 non-mock resolutions
// in 200 concurrent-import rounds, 0 in sequential rounds; in the
// pairing test the losing side got the real WebrtcProvider, never synced
// — no WebRTC in Node, signaling unreachable — so both docs kept only
// their own hello and both sides hit the 10 s poll timeout). A single
// shared promise means only the first caller executes import(); every
// later caller awaits the same module. The timeout itself was never the
// problem and is unchanged.
let webrtcModulePromise: Promise<typeof import('y-webrtc')> | null = null
function loadWebrtc(): Promise<typeof import('y-webrtc')> {
  return (webrtcModulePromise ??= import('y-webrtc'))
}

async function connectEphemeral(
  room: string,
  doc: Y.Doc,
  signaling: string,
): Promise<WebrtcProviderType> {
  const { WebrtcProvider } = await loadWebrtc()
  return new WebrtcProvider(room, doc, {
    // Rendezvous on the invite's signaling AND every configured hub, so
    // pairing succeeds as long as both sides share one live hub (Phase 4).
    signaling: getSignalingUrls(signaling),
    peerOpts: { config: { iceServers: getIceServers() } },
  })
}

export interface RunPairingOptions {
  /**
   * M2 single-use enforcement: refuse a pairing on an invite this
   * device already used, and record the invite as used on success.
   * The app's pairing entry points (FriendsPanel, both sides) pass
   * true. The library default is false so the S8 separate-channels
   * guarantee — two pairings on one reused invite land in different
   * rooms — stays provable at this layer; the used-invite store is
   * the enforcement mechanism either way.
   */
  singleUse?: boolean
  /**
   * M3: the display name the guest expects (the name on the invite
   * they scanned). A hello announcing a different name is skipped,
   * never accepted — the inviter cannot swap names mid-pairing.
   */
  expectedPeerName?: string | null
}

/**
 * Run the pairing handshake for one side. `expectedPeerDid` pins the peer
 * (the guest scanned the inviter's DID, so it accepts only that DID); the
 * inviter passes null and accepts whoever shows up with the invite.
 * Resolves with the persisted friend record.
 *
 * Bad hellos are SKIPPED, never fatal (M4): the first unverifiable
 * hello used to throw and abort the whole pairing, so one malformed
 * hello — or one racer — was a pairing DoS. Now an unverifiable, wrong-
 * DID, wrong-name, or name-unbound hello is ignored and polling
 * continues until a good hello arrives or the timeout fires (which
 * reports how many bad hellos were ignored).
 */
export async function runPairing(
  identity: Identity,
  myName: string,
  invite: FriendInvitePayload,
  expectedPeerDid: string | null,
  kv: KeyValueStore = secretKv,
  timeoutMs = 90000,
  opts: RunPairingOptions = {},
): Promise<FriendRecord> {
  await cryptoReady()
  // M8: refuse a malformed pair secret before deriving anything from it.
  validatePairSecret(invite.pairSecret)
  const pairId = await pairIdFor(invite.pairSecret)
  // M2: single-use — an invite this device already paired on is spent.
  if (opts.singleUse && isInviteUsed(pairId, invite.room, kv)) {
    throw new Error(
      'This invite code has already been used — ask your friend to show a fresh invite code.',
    )
  }
  const doc = new Y.Doc()
  const provider = await connectEphemeral(invite.room, doc, invite.signaling)
  try {
    // My hello, signed (v2 + M3 name) — the same hello the manual-SDP
    // fallback sends over its data channel (see manualSdp.ts).
    const mine = await buildMyHello(identity, myName, invite.room, pairId)
    doc.transact(() => {
      doc.getMap(HELLO_MAP).set(identity.did, JSON.stringify(mine))
    })

    // Hellos already judged bad this run (did + sig): never re-verify
    // them on every poll — they cannot become good.
    const skippedBad = new Set<string>()
    let skippedCount = 0
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
      for (const hello of hellos) {
        const badKey = `${hello.did}:${hello.sig}`
        if (skippedBad.has(badKey)) continue
        const skip = (): void => {
          skippedBad.add(badKey)
          skippedCount++
        }
        // Bad hellos are SKIPPED, never fatal (M4) — the shared
        // verifier (also used by the manual-SDP fallback) judges each
        // hello; an unverifiable, wrong-DID, wrong-name, or
        // name-unbound hello is ignored and polling continues.
        const verified = await verifyPeerHello(hello, {
          room: invite.room,
          pairId,
          expectedPeerDid,
          expectedPeerName: opts.expectedPeerName,
        })
        if (!verified.ok) {
          skip()
          continue
        }
        return await finalizePairing(
          verified,
          invite,
          pairId,
          identity.did,
          kv,
          opts,
        )
      }
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(
          'Pairing timed out — the other device never answered.' +
            (skippedCount > 0
              ? ` (${skippedCount} unverifiable hello${skippedCount === 1 ? '' : 's'} ignored.)`
              : ''),
        )
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
    const { WebrtcProvider } = await loadWebrtc()
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

/** Whether this device currently holds a live provider for a friend's channel. */
export function hasFriendChannelProvider(friendDid: string): boolean {
  return channelProviders.has(friendDid)
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
  kv: KeyValueStore = secretKv,
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
