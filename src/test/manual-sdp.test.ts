/**
 * Manual-SDP fallback pairing (E3 — PLAN.md §2, §4.0).
 *
 * The manual fallback does not exist in the signaling path's tests:
 * it is a second transport for the same handshake, so these tests
 * prove the two properties that matter at this layer —
 *
 *   1. the SDP blob codec round-trips and rejects everything malformed
 *      (wrong kind/version, bad SDP, expired or short-secret invite,
 *      oversized blob, bare blob and full link forms);
 *   2. the hello exchange over the in-memory loopback channels runs
 *      the REAL pairing code (buildMyHello → verifyPeerHello →
 *      finalizePairing): both sides persist DID-bound friend records
 *      with equal channel tags, the guest pins the inviter's DID and
 *      name, forged / swapped-name / wrong-secret hellos are skipped
 *      and the genuine hello still pairs, single-use enforcement
 *      applies, and a second pairing on one reused invite lands in a
 *      different channel (S8 backstop). The isolation tests prove each
 *      verifier check separately: with only the forged hello ever
 *      sent, a check that failed to reject would pair — so each
 *      check's test fails if that check is disabled (verified by
 *      mutation: disabling the DID pin turns the racer tests red).
 *
 * What these tests CANNOT prove: the browser's WebRTC stack itself.
 * Node has no RTCPeerConnection, so createManualOffer /
 * acceptManualOffer fail closed there (asserted below); the live
 * two-device exchange is the emulator proof's job, not this file's.
 */
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import {
  base64ToU8,
  base64UrlToU8,
  u8ToBase64Url,
  u8ToUtf8,
  utf8ToU8,
} from '../identity/codec'
import {
  identityFromSeed,
  verifyDetached,
  type Identity,
} from '../identity/identity'
import {
  buildMyHello,
  channelTagFor,
  createFriendInvite,
  helloMessage,
  isInviteUsed,
  listFriends,
  pairIdFor,
  type FriendInvitePayload,
  type Hello,
} from '../friends/friends'
import {
  acceptManualOffer,
  createLoopbackHelloChannels,
  createManualOffer,
  decodeManualAnswer,
  decodeManualOffer,
  encodeManualAnswer,
  encodeManualOffer,
  exchangeHelloOverChannel,
  extractManualBlob,
  isManualSdpSupported,
  manualOfferLink,
  MANUAL_SDP_BLOB_MAX_CHARS,
  type HelloChannel,
} from '../friends/manualSdp'
import { memoryStore } from '../store/recipes'

const seed = (n: number) => new Uint8Array(32).fill(n)

const FAKE_SDP = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=mid:0',
].join('\r\n')

async function makeInvite(): Promise<{
  alice: Identity
  invite: FriendInvitePayload
}> {
  const alice = await identityFromSeed(seed(41))
  const invite = await createFriendInvite(alice, 'Alice', 'wss://test:4444')
  return { alice, invite }
}

/** A one-sided driver: send hellos into `out`, never answer. */
function driveOneSide(
  channel: HelloChannel,
  hellos: Hello[],
): void {
  for (const h of hellos) channel.sendHello(JSON.stringify(h))
}

describe('manual SDP blob codec', () => {
  it('offer round-trips: SDP + invite survive encode/decode', async () => {
    const { invite } = await makeInvite()
    const blob = encodeManualOffer(FAKE_SDP, invite)
    expect(blob).not.toContain('+')
    expect(blob).not.toContain('/')
    expect(blob).not.toContain('=')
    const back = decodeManualOffer(blob)
    expect(back.sdp).toBe(FAKE_SDP)
    expect(back.invite.did).toBe(invite.did)
    expect(back.invite.room).toBe(invite.room)
    expect(back.invite.pairSecret).toBe(invite.pairSecret)
    expect(back.invite.name).toBe('Alice')
  })

  it('answer round-trips', () => {
    const blob = encodeManualAnswer(FAKE_SDP)
    expect(decodeManualAnswer(blob).sdp).toBe(FAKE_SDP)
  })

  it('offer link form: blob baked into the URL hash, extractable', async () => {
    const { invite } = await makeInvite()
    const blob = encodeManualOffer(FAKE_SDP, invite)
    const link = manualOfferLink(blob, 'http://localhost:5173/')
    expect(link).toBe(`http://localhost:5173/#lt-manual-offer=${blob}`)
    // The full link pastes straight into the decoder.
    expect(decodeManualOffer(link).sdp).toBe(FAKE_SDP)
    // And the extractor returns the bare blob.
    expect(extractManualBlob(link)).toBe(blob)
    expect(extractManualBlob(`  ${blob}  `)).toBe(blob)
  })

  it('rejects garbage, wrong kind/version, bad SDP, and oversized blobs', async () => {
    const { invite } = await makeInvite()
    const good = encodeManualOffer(FAKE_SDP, invite)
    expect(() => decodeManualOffer('not-a-blob')).toThrow(/not valid/)
    expect(() => decodeManualOffer('')).toThrow(/not valid/)
    expect(() => decodeManualOffer('A'.repeat(MANUAL_SDP_BLOB_MAX_CHARS + 1))).toThrow(
      /not valid/,
    )
    // Wrong kind: an answer blob is not an offer.
    expect(() => decodeManualOffer(encodeManualAnswer(FAKE_SDP))).toThrow(
      /not valid/,
    )
    // Wrong version.
    const wrongVersion = u8ToBase64Url(
      utf8ToU8(
        JSON.stringify({ v: 2, kind: 'manual-offer', sdp: FAKE_SDP, invite }),
      ),
    )
    expect(() => decodeManualOffer(wrongVersion)).toThrow(/not valid/)
    // SDP that is not SDP.
    const badSdp = encodeManualOffer('hello, not sdp', invite)
    expect(() => decodeManualOffer(badSdp)).toThrow(/not valid/)
    // Kind swapped after encoding: an answer-shaped blob is not an offer.
    const kindSwapped = u8ToBase64Url(
      utf8ToU8(
        JSON.stringify({
          v: 1,
          kind: 'manual-answer',
          sdp: FAKE_SDP,
          invite,
        }),
      ),
    )
    expect(() => decodeManualOffer(kindSwapped)).toThrow(/not valid/)
    // Truncated blob: the JSON no longer parses.
    expect(() => decodeManualOffer(good.slice(0, -4))).toThrow()
    // Answer side mirrors the same rejections.
    expect(() => decodeManualAnswer(good)).toThrow(/not valid/)
    expect(() => decodeManualAnswer('junk')).toThrow(/not valid/)
  })

  it('rejects an expired invite and a short-secret invite inside the offer', async () => {
    const { alice, invite } = await makeInvite()
    const expired = {
      ...invite,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }
    expect(() => decodeManualOffer(encodeManualOffer(FAKE_SDP, expired))).toThrow(
      /expired/,
    )
    const shortSecret = { ...invite, pairSecret: 'AAAA' }
    expect(() =>
      decodeManualOffer(encodeManualOffer(FAKE_SDP, shortSecret)),
    ).toThrow(/not a valid/)
    // An invite for a different DID is still a structurally valid
    // offer — the DID pin is enforced by the hello exchange, not the codec.
    const bob = await identityFromSeed(seed(42))
    const bobsInvite = await createFriendInvite(bob, 'Bob', 'wss://test:4444')
    expect(decodeManualOffer(encodeManualOffer(FAKE_SDP, bobsInvite)).invite.did).toBe(
      bob.did,
    )
    expect(alice.did).not.toBe(bob.did)
  })

  it('base64url helpers round-trip bytes that would use +/= in base64', () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xfe, 0x00, 0x80, 0xff])
    const url = u8ToBase64Url(bytes)
    expect(url).not.toMatch(/[+/=]/)
    expect(base64UrlToU8(url)).toEqual(bytes)
    expect(() => base64UrlToU8('a+b/c=')).toThrow()
    expect(u8ToUtf8(utf8ToU8('héllo'))).toBe('héllo')
  })
})

describe('manual hello exchange (loopback channels, real pairing code)', () => {
  it('two devices pair with no signaling: DID-bound records, equal channel tags', async () => {
    const alice = await identityFromSeed(seed(41))
    const bob = await identityFromSeed(seed(42))
    const invite = await createFriendInvite(alice, 'Alice', 'wss://test:4444')
    const kvA = memoryStore()
    const kvB = memoryStore()
    const [chA, chB] = createLoopbackHelloChannels()
    const [recA, recB] = await Promise.all([
      exchangeHelloOverChannel(chA, alice, 'Alice', invite, null, kvA, 10000, {
        singleUse: true,
      }),
      exchangeHelloOverChannel(chB, bob, 'Bob', invite, alice.did, kvB, 10000, {
        singleUse: true,
        expectedPeerName: 'Alice',
      }),
    ])
    // Each side persisted the other.
    expect(recA.did).toBe(bob.did)
    expect(recB.did).toBe(alice.did)
    expect(recA.name).toBe('Bob')
    expect(recB.name).toBe('Alice')
    expect(recA.pairId).toBe(recB.pairId)
    expect(recA.pairId).toBe(await pairIdFor(invite.pairSecret))
    // S8: both sides derive the SAME DID-bound channel tag.
    expect(recA.channelTag).toBe(recB.channelTag)
    expect(recA.channelTag).toBe(
      channelTagFor(recA.pairId, alice.did, bob.did),
    )
    // The persisted lists agree.
    expect(listFriends(kvA)).toHaveLength(1)
    expect(listFriends(kvB)).toHaveLength(1)
    // M2: the invite is spent on both devices.
    expect(isInviteUsed(recA.pairId, invite.room, kvA)).toBe(true)
    expect(isInviteUsed(recB.pairId, invite.room, kvB)).toBe(true)
  })

  it('a racer holding the invite is skipped; the genuine hello still pairs', async () => {
    const alice = await identityFromSeed(seed(41))
    const bob = await identityFromSeed(seed(42))
    const mallory = await identityFromSeed(seed(43))
    const invite = await createFriendInvite(alice, 'Alice', 'wss://test:4444')
    const pairId = await pairIdFor(invite.pairSecret)
    const kvA = memoryStore()
    const kvB = memoryStore()
    const [chA, chB] = createLoopbackHelloChannels()
    // Mallory holds the invite code (she copied it) and races Alice:
    // her hello is correctly signed under the pair secret, for HER DID —
    // and she announces Alice's name, so the name check passes too.
    // Only the DID pin (Bob expects Alice's DID) rejects her.
    const malloryHello = await buildMyHello(mallory, 'Alice', invite.room, pairId)
    const bobPairing = exchangeHelloOverChannel(
      chB,
      bob,
      'Bob',
      invite,
      alice.did,
      kvB,
      10000,
      { expectedPeerName: 'Alice' },
    )
    // The forged hello goes first and is processed before Alice's
    // genuine hello exists (Bob's own hello is dropped — nobody is
    // listening on Alice's side yet — and re-sent below).
    driveOneSide(chA, [malloryHello])
    await new Promise((r) => setTimeout(r, 10))
    const alicePairing = exchangeHelloOverChannel(
      chA,
      alice,
      'Alice',
      invite,
      null,
      kvA,
      10000,
    )
    driveOneSide(chB, [await buildMyHello(bob, 'Bob', invite.room, pairId)])
    const [recA, recB] = await Promise.all([alicePairing, bobPairing])
    expect(recB.did).toBe(alice.did)
    expect(recB.name).toBe('Alice')
    expect(recA.did).toBe(bob.did)
  })

  it('a name swapped after signing is skipped; the genuine hello still pairs', async () => {
    const alice = await identityFromSeed(seed(41))
    const bob = await identityFromSeed(seed(42))
    const invite = await createFriendInvite(alice, 'Alice', 'wss://test:4444')
    const pairId = await pairIdFor(invite.pairSecret)
    const kvA = memoryStore()
    const kvB = memoryStore()
    const [chA, chB] = createLoopbackHelloChannels()
    // Alice's real hello, then the same hello with the name rewritten
    // after signing — Bob expects 'Alice', so the expected-name check
    // rejects the swapped copy (the name-signature check itself is
    // isolated in the test below) and the genuine hello still pairs.
    // The swapped copy is delivered first, before Alice's exchange
    // starts; Bob's own hello is re-sent once Alice is listening.
    const genuine = await buildMyHello(alice, 'Alice', invite.room, pairId)
    const swapped: Hello = { ...genuine, name: 'Mallory' }
    const bobPairing = exchangeHelloOverChannel(
      chB,
      bob,
      'Bob',
      invite,
      alice.did,
      kvB,
      10000,
      { expectedPeerName: 'Alice' },
    )
    driveOneSide(chA, [swapped])
    await new Promise((r) => setTimeout(r, 10))
    const alicePairing = exchangeHelloOverChannel(
      chA,
      alice,
      'Alice',
      invite,
      null,
      kvA,
      10000,
    )
    driveOneSide(chB, [await buildMyHello(bob, 'Bob', invite.room, pairId)])
    const [, recB] = await Promise.all([alicePairing, bobPairing])
    expect(recB.did).toBe(alice.did)
    expect(recB.name).toBe('Alice')
  })

  it('a hello signed under a different pair secret is skipped', async () => {
    const alice = await identityFromSeed(seed(41))
    const bob = await identityFromSeed(seed(42))
    const invite = await createFriendInvite(alice, 'Alice', 'wss://test:4444')
    const otherInvite = await createFriendInvite(alice, 'Alice', 'wss://test:4444')
    const pairId = await pairIdFor(invite.pairSecret)
    const kvA = memoryStore()
    const kvB = memoryStore()
    const [chA, chB] = createLoopbackHelloChannels()
    // A hello signed for a DIFFERENT invite's pair secret: it cannot
    // verify against this pairing's pairId.
    const wrongSecretHello = await buildMyHello(
      alice,
      'Alice',
      invite.room,
      await pairIdFor(otherInvite.pairSecret),
    )
    const bobPairing = exchangeHelloOverChannel(
      chB,
      bob,
      'Bob',
      invite,
      alice.did,
      kvB,
      10000,
      { expectedPeerName: 'Alice' },
    )
    driveOneSide(chA, [wrongSecretHello])
    await new Promise((r) => setTimeout(r, 10))
    const alicePairing = exchangeHelloOverChannel(
      chA,
      alice,
      'Alice',
      invite,
      null,
      kvA,
      10000,
    )
    driveOneSide(chB, [await buildMyHello(bob, 'Bob', invite.room, pairId)])
    const [, recB] = await Promise.all([alicePairing, bobPairing])
    expect(recB.did).toBe(alice.did)
  })

  it('times out clearly when the other device never answers', async () => {
    const alice = await identityFromSeed(seed(41))
    const invite = await createFriendInvite(alice, 'Alice', 'wss://test:4444')
    const [chA] = createLoopbackHelloChannels()
    await expect(
      exchangeHelloOverChannel(chA, alice, 'Alice', invite, null, memoryStore(), 200),
    ).rejects.toThrow(/Pairing timed out/)
  })

  // Isolation tests: each check alone must refuse the forgery. Only
  // the forged hello is ever sent (the genuine one never exists), so
  // a check that failed to reject would pair — the test would fail,
  // not merely pass for the wrong reason.
  it('isolation: a racer announcing the right name is still refused (DID pin)', async () => {
    const alice = await identityFromSeed(seed(41))
    const bob = await identityFromSeed(seed(42))
    const mallory = await identityFromSeed(seed(43))
    const invite = await createFriendInvite(alice, 'Alice', 'wss://test:4444')
    const pairId = await pairIdFor(invite.pairSecret)
    const [aCh, bCh] = createLoopbackHelloChannels()
    const forged = await buildMyHello(mallory, 'Alice', invite.room, pairId)
    const pairing = exchangeHelloOverChannel(
      bCh,
      bob,
      'Bob',
      invite,
      alice.did,
      memoryStore(),
      500,
      { expectedPeerName: 'Alice' },
    )
    driveOneSide(aCh, [forged])
    await expect(pairing).rejects.toThrow(/Pairing timed out/)
  })

  it('isolation: a hello signed under another pair secret is never accepted', async () => {
    const alice = await identityFromSeed(seed(41))
    const bob = await identityFromSeed(seed(42))
    const invite = await createFriendInvite(alice, 'Alice', 'wss://test:4444')
    const otherInvite = await createFriendInvite(alice, 'Alice', 'wss://test:4444')
    const [aCh, bCh] = createLoopbackHelloChannels()
    const forged = await buildMyHello(
      alice,
      'Alice',
      invite.room,
      await pairIdFor(otherInvite.pairSecret),
    )
    const pairing = exchangeHelloOverChannel(
      bCh,
      bob,
      'Bob',
      invite,
      alice.did,
      memoryStore(),
      500,
      { expectedPeerName: 'Alice' },
    )
    driveOneSide(aCh, [forged])
    await expect(pairing).rejects.toThrow(/Pairing timed out/)
  })

  it('isolation: a hello with the name rewritten after signing is never accepted', async () => {
    const alice = await identityFromSeed(seed(41))
    const invite = await createFriendInvite(alice, 'Alice', 'wss://test:4444')
    const pairId = await pairIdFor(invite.pairSecret)
    const [aCh, bCh] = createLoopbackHelloChannels()
    const genuine = await buildMyHello(alice, 'Alice', invite.room, pairId)
    const swapped: Hello = { ...genuine, name: 'Mallory' }
    // Inviter side: no expected DID or name, so the ONLY thing that
    // can reject this hello is the v2 name-signature check (the
    // announced name 'Mallory' is not what the nameSig vouches for).
    const pairing = exchangeHelloOverChannel(
      bCh,
      alice,
      'Alice',
      invite,
      null,
      memoryStore(),
      500,
    )
    driveOneSide(aCh, [swapped])
    await expect(pairing).rejects.toThrow(/Pairing timed out/)
  })

  it('single-use: a second exchange on the same invite is refused', async () => {
    const alice = await identityFromSeed(seed(41))
    const bob = await identityFromSeed(seed(42))
    const invite = await createFriendInvite(alice, 'Alice', 'wss://test:4444')
    const kvA = memoryStore()
    const kvB = memoryStore()
    const [chA, chB] = createLoopbackHelloChannels()
    await Promise.all([
      exchangeHelloOverChannel(chA, alice, 'Alice', invite, null, kvA, 10000, {
        singleUse: true,
      }),
      exchangeHelloOverChannel(chB, bob, 'Bob', invite, alice.did, kvB, 10000, {
        singleUse: true,
        expectedPeerName: 'Alice',
      }),
    ])
    const [chA2, chB2] = createLoopbackHelloChannels()
    await expect(
      exchangeHelloOverChannel(chA2, alice, 'Alice', invite, null, kvA, 10000, {
        singleUse: true,
      }),
    ).rejects.toThrow(/already been used/)
    await expect(
      exchangeHelloOverChannel(chB2, bob, 'Bob', invite, alice.did, kvB, 10000, {
        singleUse: true,
      }),
    ).rejects.toThrow(/already been used/)
  })

  it('two pairings on one reused invite land in different channels (S8 backstop)', async () => {
    const alice = await identityFromSeed(seed(41))
    const bob = await identityFromSeed(seed(42))
    const carol = await identityFromSeed(seed(44))
    const invite = await createFriendInvite(alice, 'Alice', 'wss://test:4444')
    const kvA = memoryStore()
    const [chA1, chB] = createLoopbackHelloChannels()
    const [recA1] = await Promise.all([
      exchangeHelloOverChannel(chA1, alice, 'Alice', invite, null, kvA, 10000),
      exchangeHelloOverChannel(chB, bob, 'Bob', invite, alice.did, memoryStore(), 10000, {
        expectedPeerName: 'Alice',
      }),
    ])
    const [chA2, chC] = createLoopbackHelloChannels()
    const [recA2] = await Promise.all([
      exchangeHelloOverChannel(chA2, alice, 'Alice', invite, null, kvA, 10000),
      exchangeHelloOverChannel(chC, carol, 'Carol', invite, alice.did, memoryStore(), 10000, {
        expectedPeerName: 'Alice',
      }),
    ])
    expect(recA1.channelTag).not.toBe(recA2.channelTag)
    expect(listFriends(kvA)).toHaveLength(2)
  })

  it('the shared hello bytes are exactly the v2 message', async () => {
    const alice = await identityFromSeed(seed(41))
    const invite = await createFriendInvite(alice, 'Alice', 'wss://test:4444')
    const pairId = await pairIdFor(invite.pairSecret)
    const hello = await buildMyHello(alice, 'Alice', invite.room, pairId)
    expect(hello.channelVersion).toBe(2)
    // The signature verifies against the v2 message — the same bytes
    // the signaling path signs. A hello for another room does not.
    expect(
      await verifyDetached(
        alice.did,
        helloMessage(invite.room, alice.did, pairId),
        base64ToU8(hello.sig),
      ),
    ).toBe(true)
    expect(
      await verifyDetached(
        alice.did,
        helloMessage('longtable-pair-0000000000000000', alice.did, pairId),
        base64ToU8(hello.sig),
      ),
    ).toBe(false)
    // The name signature covers the v3 name message.
    expect(typeof hello.nameSig).toBe('string')
    expect(hello.nameSig).not.toBe(hello.sig)
  })
})

describe('WebRTC availability boundary (Node has none)', () => {
  it('reports unsupported in Node and fails closed with a clear error', async () => {
    expect(isManualSdpSupported()).toBe(false)
    const { invite } = await makeInvite()
    await expect(createManualOffer(invite)).rejects.toThrow(/WebRTC/)
    await expect(
      acceptManualOffer(encodeManualOffer(FAKE_SDP, invite)),
    ).rejects.toThrow(/WebRTC/)
  })
})
