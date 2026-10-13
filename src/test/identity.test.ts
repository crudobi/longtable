/**
 * Identity layer unit tests: did:key encoding (pinned vector), sign/verify,
 * and the Ed25519→Curve25519 conversion powering sealed-box key wrapping.
 */
import { describe, expect, it } from 'vitest'
import {
  didFromPublicKey,
  encPublicKeyForDid,
  generateIdentity,
  getOrCreateIdentity,
  identityFromSeed,
  publicKeyFromDid,
  signDetached,
  verifyDetached,
} from '../identity/identity'
import { base58btcDecode, base58btcEncode, utf8ToU8 } from '../identity/codec'
import { memoryStore } from '../store/recipes'
import sodium from 'libsodium-wrappers'

const SEED = new Uint8Array(32).fill(7)
// Pinned vector: seed 0x07*32 -> pubkey ea4a6c63...446d22c (computed with
// libsodium crypto_sign_seed_keypair) -> this did:key. If this changes, the
// DID encoding changed and every existing friendship breaks — do not update
// it casually.
const SEED_DID = 'did:key:z6MkvDqGT54cXesYGvABpF1UapVNwjCqRcafi4Px6Thv5T3Z'

describe('base58btc', () => {
  it('round-trips and handles zero bytes', () => {
    for (const bytes of [
      new Uint8Array([0]),
      new Uint8Array([0, 0]),
      new Uint8Array([0, 0, 5]),
      new Uint8Array([0xed, 0x01, 0xaa, 0xbb]),
      new Uint8Array(34).map((_, i) => i * 7),
    ]) {
      expect(base58btcDecode(base58btcEncode(bytes))).toEqual(bytes)
    }
    expect(base58btcEncode(new Uint8Array([0]))).toBe('1')
    expect(base58btcEncode(new Uint8Array([0, 0]))).toBe('11')
  })
})

describe('identity', () => {
  it('derives the pinned did:key from a fixed seed', async () => {
    const id = await identityFromSeed(SEED)
    expect(id.did).toBe(SEED_DID)
    expect(didFromPublicKey(id.publicKey)).toBe(SEED_DID)
    expect(publicKeyFromDid(id.did)).toEqual(id.publicKey)
  })

  it('persists across getOrCreateIdentity calls', async () => {
    const kv = memoryStore()
    const a = await getOrCreateIdentity(kv)
    const b = await getOrCreateIdentity(kv)
    expect(b.did).toBe(a.did)
    expect(b.secretKey).toEqual(a.secretKey)
  })

  it('signs and verifies; wrong DID and tampered messages fail', async () => {
    const alice = await identityFromSeed(new Uint8Array(32).fill(1))
    const mallory = await generateIdentity()
    const msg = utf8ToU8('longtable:hello')
    const sig = await signDetached(alice, msg)
    expect(await verifyDetached(alice.did, msg, sig)).toBe(true)
    expect(await verifyDetached(mallory.did, msg, sig)).toBe(false)
    expect(await verifyDetached(alice.did, utf8ToU8('longtable:tampered'), sig)).toBe(false)
  })

  it('rejects malformed DIDs', () => {
    expect(() => publicKeyFromDid('did:plc:abc')).toThrow()
    expect(() => publicKeyFromDid('did:key:z6Mkshort')).toThrow()
    expect(() => publicKeyFromDid('not-a-did')).toThrow()
  })

  it('sealed box: anyone can wrap to a DID, only the owner opens', async () => {
    await sodium.ready
    const owner = await identityFromSeed(new Uint8Array(32).fill(3))
    const stranger = await generateIdentity()
    const secret = new Uint8Array(32).fill(42)
    // Wrap using ONLY the owner's DID (what a friend does).
    const encPk = await encPublicKeyForDid(owner.did)
    const sealed = sodium.crypto_box_seal(secret, encPk)
    // Owner opens with converted secret key.
    const opened = sodium.crypto_box_seal_open(
      sealed,
      owner.encPublicKey,
      owner.encSecretKey,
    )
    expect(opened).toEqual(secret)
    // Stranger cannot.
    expect(() =>
      sodium.crypto_box_seal_open(sealed, stranger.encPublicKey, stranger.encSecretKey),
    ).toThrow()
  })
})
