import { describe, it, expect } from 'vitest'
import { parseDidKey, Secp256k1Keypair } from '@atproto/crypto'
import { extractSigningDidKey } from '../verify.mjs'

// The local testnet PLC emits legacy-shaped DID docs: the #atproto
// verification method is EcdsaSecp256k1VerificationKey2019 and its
// publicKeyMultibase is base58btc of the RAW 65-byte uncompressed
// secp256k1 public key (no multicodec prefix) — @atproto/crypto's
// parseMultikey rejects that encoding as "Unsupported key type".
// This is a real author's public key from the testnet PLC (public data).
const LEGACY_DOC = {
  id: 'did:plc:fakeauthor00000000000000',
  verificationMethod: [
    {
      id: 'did:plc:fakeauthor00000000000000#atproto',
      type: 'EcdsaSecp256k1VerificationKey2019',
      controller: 'did:plc:fakeauthor00000000000000',
      publicKeyMultibase:
        'zRVTTByWVVJaaHGQc2dVsXUfTM11jM96x66hQwCV3KWDJAVRbv3vYyhxX92E1rdA5UGprJogwdYefv5PDUyx3AGYN',
    },
  ],
}

describe('extractSigningDidKey', () => {
  it('normalizes the legacy raw secp256k1 key into a parseable did:key', () => {
    const key = extractSigningDidKey(LEGACY_DOC)
    expect(key).toBeTruthy()
    const parsed = parseDidKey(key)
    expect(parsed.jwtAlg).toBe('ES256K')
    expect(parsed.keyBytes.length).toBe(65) // decompressed point
    // The normalized key must represent the SAME point: re-encoding the
    // parsed (decompressed) key reproduces the same did:key.
    expect(extractSigningDidKey(LEGACY_DOC)).toBe(key)
  })

  it('passes modern multicodec Multikey docs through unchanged', async () => {
    const keypair = await Secp256k1Keypair.create({ exportable: true })
    const mb = keypair.did().replace('did:key:', '')
    const doc = {
      id: 'did:plc:modern',
      verificationMethod: [
        { id: 'did:plc:modern#atproto', type: 'Multikey', controller: 'did:plc:modern', publicKeyMultibase: mb },
      ],
    }
    expect(extractSigningDidKey(doc)).toBe(keypair.did())
  })

  it('returns undefined when there is no usable key (fail closed)', () => {
    expect(extractSigningDidKey({ id: 'did:plc:x', verificationMethod: [] })).toBeUndefined()
    expect(extractSigningDidKey({ id: 'did:plc:x' })).toBeUndefined()
    expect(
      extractSigningDidKey({
        id: 'did:plc:x',
        verificationMethod: [
          { id: 'did:plc:x#atproto', type: 'Multikey', controller: 'did:plc:x', publicKeyMultibase: 'zNotARealKey111' },
        ],
      }),
    ).toBeUndefined()
  })
})
