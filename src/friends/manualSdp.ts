/**
 * Manual-SDP fallback pairing (E3 — PLAN.md §2, §4.0).
 *
 * The promise: two people pair as friends with no hub in the path at
 * all — no signaling server, no account, no email. The signaling path
 * (friends.ts runPairing) already needs a live hub to rendezvous on;
 * this module is the fallback when none is reachable: the two devices
 * exchange WebRTC session descriptions by hand (copy/paste, or the
 * offer baked into a link's URL hash, answer pasted back — the
 * imjasonh pattern PLAN.md cites) and pair over the direct
 * RTCPeerConnection data channel that results.
 *
 * What changes vs the signaling path: ONLY the transport. The
 * pairing itself is the same handshake, run through the same code:
 *
 *   - the invite is the same v2 FriendInvitePayload (DID, one-time
 *     room, 32-byte pair secret, 24 h expiry) — the offer blob
 *     carries it, so the guest learns the inviter's DID and the pair
 *     secret from the blob, exactly as from a scanned QR code;
 *   - the hello is the same signed v2 hello (buildMyHello) and is
 *     judged by the same verifier (verifyPeerHello): the guest pins
 *     the inviter's DID and display name from the invite, the
 *     inviter accepts whoever holds the invite, a bad hello is
 *     skipped, never fatal (M4);
 *   - the friend record is persisted by the same finalizePairing:
 *     the channel is still bound to BOTH DIDs (channelTag, S8) and
 *     single-use invite enforcement (M2) still applies.
 *
 * What does NOT change, and must not be mistaken for a downgrade:
 *
 *   - The data channel is a DTLS-encrypted WebRTC channel, like the
 *     y-webrtc channels the app already uses. The SDP blob itself
 *     carries the pair secret, so it is a bearer credential exactly
 *     like the invite code: copy/paste it, never log it, never put
 *     it in a message that outlives the pairing. (The URL-hash link
 *     keeps the blob out of the query string and out of server logs;
 *     the panel clears the hash after reading it.)
 *   - ICE servers (STUN/TURN from the configured hubs) are still
 *     used for NAT traversal when configured — the fallback removes
 *     the *signaling* server from the path, not the traversal
 *     helpers. With no ICE servers configured it still works on a
 *     LAN (host candidates). No TURN credential ever appears in the
 *     blob: candidates carry ufrag/passwords for the ICE session,
 *     which are single-use by construction.
 *   - ICE is gathered up front (non-trickle): createOffer waits for
 *     gathering to complete (bounded by MANUAL_SDP_ICE_TIMEOUT_MS,
 *     then proceeds with what was gathered), so the exchange is one
 *     offer blob and one answer blob, not a stream of candidates.
 *
 * Testability: Node has no RTCPeerConnection, so the WebRTC half is
 * behind isManualSdpSupported() (false in Node, true in browsers and
 * the Capacitor WebView) and the hello exchange is factored through
 * the HelloChannel interface — unit tests run the REAL exchange
 * (build/verify/finalize) over an in-memory loopback pair, and the
 * SDP blob codec is tested directly. A two-device emulator proof is
 * the remaining step (see the report): the unit tests prove the
 * pairing logic, not the browser's ICE stack.
 */
import {
  base64UrlToU8,
  u8ToBase64Url,
  u8ToUtf8,
  utf8ToU8,
} from '../identity/codec'
import {
  cryptoReady,
  type Identity,
  type KeyValueStore,
} from '../identity/identity'
import { secretKv } from '../secrets/secretStore'
import {
  buildMyHello,
  finalizePairing,
  isInviteUsed,
  pairIdFor,
  parseFriendInvite,
  validatePairSecret,
  verifyPeerHello,
  type FriendInvitePayload,
  type FriendRecord,
  type Hello,
  type RunPairingOptions,
} from './friends'

/** Blob format version. Bump if the offer/answer JSON shape changes. */
export const MANUAL_SDP_VERSION = 1

/** URL-hash parameter carrying a manual offer (`#lt-manual-offer=<blob>`). */
export const MANUAL_OFFER_HASH_PARAM = 'lt-manual-offer'

/**
 * SDP blobs are a few KB (offer + candidates); 64 KiB is far above any
 * legitimate blob and bounds what a pasted blob can make us parse.
 */
export const MANUAL_SDP_BLOB_MAX_CHARS = 65536

/** Data-channel label for the pairing hello exchange. */
export const MANUAL_SDP_DATA_CHANNEL_LABEL = 'longtable-pair'

/**
 * How long createOffer/createAnswer wait for ICE gathering to
 * complete before proceeding with the candidates gathered so far.
 * Host candidates arrive in milliseconds; srflx/relay can take
 * seconds on a slow network. This bounds the wait, it is not a
 * pairing timeout (pair() has its own 90 s default, like runPairing).
 */
export const MANUAL_SDP_ICE_TIMEOUT_MS = 10000

const OFFER_ERROR =
  'That manual offer is not valid — ask your friend to copy it again.'
const ANSWER_ERROR =
  'That manual answer is not valid — ask your friend to copy it again.'

interface ManualOfferBlob {
  v: 1
  kind: 'manual-offer'
  sdp: string
  invite: FriendInvitePayload
}

interface ManualAnswerBlob {
  v: 1
  kind: 'manual-answer'
  sdp: string
}

// ---------------------------------------------------------------------------
// Blob codec (offer/answer as one copy/pasteable base64url string)
// ---------------------------------------------------------------------------

/** Encode an offer SDP + its invite as one pasteable blob. */
export function encodeManualOffer(
  sdp: string,
  invite: FriendInvitePayload,
): string {
  const blob: ManualOfferBlob = { v: 1, kind: 'manual-offer', sdp, invite }
  return u8ToBase64Url(utf8ToU8(JSON.stringify(blob)))
}

/** Encode an answer SDP as one pasteable blob. */
export function encodeManualAnswer(sdp: string): string {
  const blob: ManualAnswerBlob = { v: 1, kind: 'manual-answer', sdp }
  return u8ToBase64Url(utf8ToU8(JSON.stringify(blob)))
}

/**
 * Pull a blob out of pasted text: either the bare blob, or a full
 * manual-offer link (`…#lt-manual-offer=<blob>`). Anything else is
 * returned as-is and fails the shape check in the decoder.
 */
export function extractManualBlob(text: string): string {
  const t = text.trim()
  const marker = `#${MANUAL_OFFER_HASH_PARAM}=`
  const idx = t.indexOf(marker)
  if (idx < 0) return t
  const raw = t.slice(idx + marker.length).split(/\s/)[0]
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/**
 * The shareable link form of an offer (PLAN.md: "offer baked into a
 * link"): the app's own URL with the blob in the hash, so it never
 * reaches a server. `base` is the page URL without a hash; it
 * defaults to the current page when one exists (browser/WebView)
 * and to a bare `#…` fragment otherwise (no domain is assumed —
 * Longtable has none by design).
 */
export function manualOfferLink(offerText: string, base = ''): string {
  const origin =
    base ||
    (typeof window !== 'undefined'
      ? `${window.location.origin}${window.location.pathname}`
      : '')
  return `${origin}#${MANUAL_OFFER_HASH_PARAM}=${offerText}`
}

/** Decode a pasted offer (blob or link) — validates the invite inside it. */
export function decodeManualOffer(text: string): {
  sdp: string
  invite: FriendInvitePayload
} {
  const blob = extractManualBlob(text)
  if (!blob || blob.length > MANUAL_SDP_BLOB_MAX_CHARS) {
    throw new Error(OFFER_ERROR)
  }
  let obj: unknown
  try {
    obj = JSON.parse(u8ToUtf8(base64UrlToU8(blob)))
  } catch {
    throw new Error(OFFER_ERROR)
  }
  const o = obj as Partial<ManualOfferBlob>
  if (
    typeof obj !== 'object' ||
    obj === null ||
    o.v !== 1 ||
    o.kind !== 'manual-offer' ||
    typeof o.sdp !== 'string' ||
    !o.sdp.startsWith('v=') ||
    typeof o.invite !== 'object' ||
    o.invite === null
  ) {
    throw new Error(OFFER_ERROR)
  }
  // parseFriendInvite enforces the invite shape, the strict 32-byte
  // pair secret, and the expiry — an expired or malformed invite
  // must not produce an offer the other side can never accept.
  const invite = parseFriendInvite(JSON.stringify(o.invite))
  return { sdp: o.sdp, invite }
}

/** Decode a pasted answer blob. */
export function decodeManualAnswer(text: string): { sdp: string } {
  const blob = text.trim()
  if (!blob || blob.length > MANUAL_SDP_BLOB_MAX_CHARS) {
    throw new Error(ANSWER_ERROR)
  }
  let obj: unknown
  try {
    obj = JSON.parse(u8ToUtf8(base64UrlToU8(blob)))
  } catch {
    throw new Error(ANSWER_ERROR)
  }
  const o = obj as Partial<ManualAnswerBlob>
  if (
    typeof obj !== 'object' ||
    obj === null ||
    o.v !== 1 ||
    o.kind !== 'manual-answer' ||
    typeof o.sdp !== 'string' ||
    !o.sdp.startsWith('v=')
  ) {
    throw new Error(ANSWER_ERROR)
  }
  return { sdp: o.sdp }
}

// ---------------------------------------------------------------------------
// Hello transport: one interface, two implementations
// ---------------------------------------------------------------------------

/**
 * The hello exchange needs exactly one thing from a transport: send
 * one JSON string, deliver the peer's. The signaling path's Y.Doc
 * polling and the manual path's RTCDataChannel both satisfy it; the
 * loopback pair below is the test implementation. The exchange
 * itself (exchangeHelloOverChannel) never sees which one it is on.
 */
export interface HelloChannel {
  sendHello(json: string): void
  onHello(cb: (json: string) => void): void
  close(): void
}

/**
 * In-memory loopback pair for tests: two channels wired to each
 * other, delivery async (setTimeout 0) like a real channel. Lets the
 * unit tests run the REAL hello exchange — build, verify, finalize,
 * single-use, channel binding — with no WebRTC in the room.
 */
export function createLoopbackHelloChannels(): [HelloChannel, HelloChannel] {
  let aCb: ((json: string) => void) | null = null
  let bCb: ((json: string) => void) | null = null
  let aClosed = false
  let bClosed = false
  // Each side has its own closed flag: one side closing (it paired
  // and is done) must not cancel a hello already in flight to the
  // other side — exactly like a real channel, where a message sent
  // before close still arrives.
  const deliver = (target: 'a' | 'b', json: string): void => {
    if (target === 'a' && aClosed) return
    if (target === 'b' && bClosed) return
    setTimeout(() => {
      if (target === 'a' && aClosed) return
      if (target === 'b' && bClosed) return
      if (target === 'a') aCb?.(json)
      else bCb?.(json)
    }, 0)
  }
  const a: HelloChannel = {
    sendHello: (json) => {
      if (!aClosed) deliver('b', json)
    },
    onHello: (cb) => {
      aCb = cb
    },
    close: () => {
      aClosed = true
    },
  }
  const b: HelloChannel = {
    sendHello: (json) => {
      if (!bClosed) deliver('a', json)
    },
    onHello: (cb) => {
      bCb = cb
    },
    close: () => {
      bClosed = true
    },
  }
  return [a, b]
}

/** Parse one received hello; null when the payload is not a hello at all. */
function helloFromJson(raw: string): Hello | null {
  try {
    const h = JSON.parse(raw) as Hello
    if (
      h &&
      typeof h === 'object' &&
      typeof h.did === 'string' &&
      typeof h.sig === 'string'
    ) {
      return h
    }
    return null
  } catch {
    return null
  }
}

/**
 * Run the pairing handshake over any HelloChannel. This is runPairing
 * with the Y.Doc polling replaced by the channel: my signed hello
 * goes out, the peer's hello is judged by the shared verifier, bad
 * hellos are skipped (M4) until a good one arrives or the timeout
 * fires, and the verified peer is persisted by finalizePairing —
 * DID-bound channel, single-use enforcement, Keystore flush, all
 * identical to the signaling path.
 */
export async function exchangeHelloOverChannel(
  channel: HelloChannel,
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
  const mine = await buildMyHello(identity, myName, invite.room, pairId)
  let skippedCount = 0
  return await new Promise<FriendRecord>((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      channel.close()
      reject(
        new Error(
          'Pairing timed out — the other device never answered.' +
            (skippedCount > 0
              ? ` (${skippedCount} unverifiable hello${skippedCount === 1 ? '' : 's'} ignored.)`
              : ''),
        ),
      )
    }, timeoutMs)
    channel.onHello((raw) => {
      if (done) return
      const hello = helloFromJson(raw)
      if (!hello) return
      void (async () => {
        const verified = await verifyPeerHello(hello, {
          room: invite.room,
          pairId,
          expectedPeerDid,
          expectedPeerName: opts.expectedPeerName,
        })
        if (done) return
        if (!verified.ok) {
          skippedCount++
          return
        }
        done = true
        clearTimeout(timer)
        try {
          const rec = await finalizePairing(
            verified,
            invite,
            pairId,
            identity.did,
            kv,
            opts,
          )
          channel.close()
          resolve(rec)
        } catch (e) {
          channel.close()
          reject(e)
        }
      })()
    })
    channel.sendHello(JSON.stringify(mine))
  })
}

// ---------------------------------------------------------------------------
// WebRTC half (browser / Capacitor WebView only)
// ---------------------------------------------------------------------------

/** False in Node (no RTCPeerConnection) — the UI hides manual pairing there. */
export function isManualSdpSupported(): boolean {
  return typeof RTCPeerConnection !== 'undefined'
}

function requireWebrtc(): void {
  if (!isManualSdpSupported()) {
    throw new Error(
      'Manual pairing needs WebRTC (RTCPeerConnection), which this browser does not provide.',
    )
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Wait for ICE gathering to finish, or proceed with what was gathered. */
async function waitForIceComplete(
  pc: RTCPeerConnection,
  timeoutMs = MANUAL_SDP_ICE_TIMEOUT_MS,
): Promise<void> {
  if (pc.iceGatheringState === 'complete') return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', onChange)
      resolve()
    }, timeoutMs)
    const onChange = (): void => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer)
        pc.removeEventListener('icegatheringstatechange', onChange)
        resolve()
      }
    }
    pc.addEventListener('icegatheringstatechange', onChange)
  })
}

/** A data channel as a HelloChannel: sends queue until the channel opens. */
function dataChannelHelloChannel(dc: RTCDataChannel): HelloChannel {
  const pending: string[] = []
  let cb: ((json: string) => void) | null = null
  dc.onmessage = (e) => {
    if (typeof e.data === 'string') cb?.(e.data)
  }
  dc.onopen = () => {
    for (const msg of pending.splice(0)) {
      try {
        dc.send(msg)
      } catch {
        // Channel died mid-send; the pairing times out with a clear message.
      }
    }
  }
  return {
    sendHello: (json) => {
      if (dc.readyState === 'open') {
        try {
          dc.send(json)
        } catch {
          // Channel died mid-send; the pairing times out with a clear message.
        }
      } else if (dc.readyState === 'connecting') {
        pending.push(json)
      }
      // closed/closing: drop — the pairing times out with a clear message.
    },
    onHello: (c) => {
      cb = c
    },
    close: () => {
      try {
        dc.close()
      } catch {
        // Already closed.
      }
    },
  }
}

export interface ManualSdpSession {
  role: 'offerer' | 'answerer'
  invite: FriendInvitePayload
  /** The offer blob (offerer only) — copy it to the other device. */
  offerText?: string
  /** The answer blob (answerer only) — copy it back to the offerer. */
  answerText?: string
  /**
   * Run the hello exchange over the session's data channel and
   * resolve with the persisted friend record. The answerer pins the
   * inviter's DID and name from the invite; the offerer accepts
   * whoever holds the invite — exactly like runPairing. The peer
   * connection is closed when pairing settles either way; the
   * persistent friend channel is a separate y-webrtc room, joined
   * afterwards via joinFriendChannel as in the signaling flow.
   */
  pair(
    identity: Identity,
    myName: string,
    kv?: KeyValueStore,
    timeoutMs?: number,
    opts?: RunPairingOptions,
  ): Promise<FriendRecord>
  /**
   * Offerer only: apply the answer SDP the guest copied back
   * (completeManualOffer). Throws on an answerer session.
   */
  applyAnswer(sdp: string): Promise<void>
  close(): void
}

class ManualSession implements ManualSdpSession {
  readonly role: 'offerer' | 'answerer'
  readonly invite: FriendInvitePayload
  readonly offerText?: string
  readonly answerText?: string
  private pc: RTCPeerConnection
  private channelPromise: Promise<RTCDataChannel>
  private closed = false

  constructor(
    role: 'offerer' | 'answerer',
    invite: FriendInvitePayload,
    pc: RTCPeerConnection,
    channelPromise: Promise<RTCDataChannel>,
    texts: { offerText?: string; answerText?: string },
  ) {
    this.role = role
    this.invite = invite
    this.pc = pc
    this.channelPromise = channelPromise
    this.offerText = texts.offerText
    this.answerText = texts.answerText
  }

  /** Offerer only: apply the answer blob the guest copied back. */
  async applyAnswer(sdp: string): Promise<void> {
    if (this.role !== 'offerer') {
      throw new Error('Only the offer side can apply an answer.')
    }
    await this.pc.setRemoteDescription({ type: 'answer', sdp })
  }

  async pair(
    identity: Identity,
    myName: string,
    kv: KeyValueStore = secretKv,
    timeoutMs = 90000,
    opts: RunPairingOptions = {},
  ): Promise<FriendRecord> {
    // One deadline for the whole pairing: waiting for the data
    // channel and exchanging hellos share it.
    const deadline = Date.now() + timeoutMs
    const dc = await this.awaitChannel(Math.max(0, deadline - Date.now()))
    const channel = dataChannelHelloChannel(dc)
    try {
      return await exchangeHelloOverChannel(
        channel,
        identity,
        myName,
        this.invite,
        this.role === 'answerer' ? this.invite.did : null,
        kv,
        Math.max(0, deadline - Date.now()),
        this.role === 'answerer'
          ? {
              ...opts,
              expectedPeerName: opts.expectedPeerName ?? this.invite.name,
            }
          : opts,
      )
    } finally {
      this.close()
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.pc.close()
    } catch {
      // Already closed.
    }
  }

  private async awaitChannel(timeoutMs: number): Promise<RTCDataChannel> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.channelPromise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  'Pairing timed out — the data channel never opened.',
                ),
              ),
            timeoutMs,
          )
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

/**
 * Offerer step 1: create a peer connection + data channel and mint
 * the offer blob for an invite. The invite is validated first, so a
 * stale invite never produces an offer the other side cannot accept.
 * `iceServers` is the configured hubs' STUN/TURN (getIceServers) —
 * NAT traversal still applies; only signaling is manual here.
 */
export async function createManualOffer(
  invite: FriendInvitePayload,
  iceServers: RTCIceServer[] = [],
): Promise<ManualSdpSession> {
  requireWebrtc()
  await cryptoReady()
  parseFriendInvite(JSON.stringify(invite))
  const pc = new RTCPeerConnection({ iceServers })
  try {
    const dc = pc.createDataChannel(MANUAL_SDP_DATA_CHANNEL_LABEL, {
      ordered: true,
    })
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await waitForIceComplete(pc)
    const sdp = pc.localDescription?.sdp
    if (!sdp) {
      throw new Error('Could not create a manual offer — no local description.')
    }
    return new ManualSession('offerer', invite, pc, Promise.resolve(dc), {
      offerText: encodeManualOffer(sdp, invite),
    })
  } catch (e) {
    try {
      pc.close()
    } catch {
      // Already closed.
    }
    throw e
  }
}

/**
 * Guest step 1: take a pasted offer (blob or link), apply it, and
 * mint the answer blob to copy back. The session's pair() then runs
 * the hello exchange once the data channel opens.
 */
export async function acceptManualOffer(
  offerText: string,
  iceServers: RTCIceServer[] = [],
): Promise<ManualSdpSession> {
  requireWebrtc()
  await cryptoReady()
  const { sdp, invite } = decodeManualOffer(offerText)
  const pc = new RTCPeerConnection({ iceServers })
  const channel = deferred<RTCDataChannel>()
  pc.ondatachannel = (e) => {
    channel.resolve(e.channel)
  }
  try {
    await pc.setRemoteDescription({ type: 'offer', sdp })
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    await waitForIceComplete(pc)
    const answerSdp = pc.localDescription?.sdp
    if (!answerSdp) {
      throw new Error(
        'Could not create a manual answer — no local description.',
      )
    }
    return new ManualSession('answerer', invite, pc, channel.promise, {
      answerText: encodeManualAnswer(answerSdp),
    })
  } catch (e) {
    try {
      pc.close()
    } catch {
      // Already closed.
    }
    throw e
  }
}

/** Offerer step 2: apply the answer blob the guest copied back. */
export async function completeManualOffer(
  session: ManualSdpSession,
  answerText: string,
): Promise<void> {
  const { sdp } = decodeManualAnswer(answerText)
  await session.applyAnswer(sdp)
}
