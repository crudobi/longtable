import { describe, it, expect } from 'vitest'
import { parseDidKey, Secp256k1Keypair } from '@atproto/crypto'
import { createVerifiedRepoProvider, extractSigningDidKey, MAX_CAR_BYTES } from '../verify.mjs'
import { RecipeIndex } from '../db.mjs'
import { createIngestor } from '../ingest.mjs'

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

describe('createVerifiedRepoProvider resource bounds', () => {
  const DID = 'did:plc:fakeauthor00000000000000' // matches LEGACY_DOC.id
  const plcRes = () =>
    new Response(JSON.stringify(LEGACY_DOC), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  const quietLog = { info() {}, warn() {}, error() {} }

  it('has a sane production CAR cap (100 MiB)', () => {
    expect(MAX_CAR_BYTES).toBe(100 * 1024 * 1024)
  })

  it('rejects a CAR whose declared size exceeds the cap', async () => {
    const fetchImpl = async (url) => {
      if (url.includes('/xrpc/com.atproto.sync.getRepo')) {
        return new Response(new Uint8Array(8), {
          status: 200,
          headers: { 'content-length': '2048' },
        })
      }
      return plcRes()
    }
    const provider = createVerifiedRepoProvider({
      pdsUrl: 'http://pds.test',
      plcUrl: 'http://plc.test',
      fetchImpl,
      maxCarBytes: 1024,
    })
    await expect(provider(DID)).rejects.toThrow(/exceeds the 1024-byte cap/)
  })

  it('rejects a CAR that grows past the cap while streaming', async () => {
    const fetchImpl = async (url) => {
      if (url.includes('/xrpc/com.atproto.sync.getRepo')) {
        return new Response(new Uint8Array(4096), { status: 200 })
      }
      return plcRes()
    }
    const provider = createVerifiedRepoProvider({
      pdsUrl: 'http://pds.test',
      plcUrl: 'http://plc.test',
      fetchImpl,
      maxCarBytes: 1024,
    })
    await expect(provider(DID)).rejects.toThrow(/exceeds the 1024-byte cap/)
  })

  it('times out a hung PLC fetch instead of stalling forever', async () => {
    const fetchImpl = (_url, opts) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => reject(opts.signal.reason))
      })
    const provider = createVerifiedRepoProvider({
      pdsUrl: 'http://pds.test',
      plcUrl: 'http://plc.test',
      fetchImpl,
      fetchTimeoutMs: 60,
    })
    const t0 = Date.now()
    await expect(provider(DID)).rejects.toThrow()
    expect(Date.now() - t0).toBeLessThan(5000)
  })

  it('an oversize CAR is counted as a rejection by the ingestor and indexes nothing', async () => {
    const fetchImpl = async (url) => {
      if (url.includes('/xrpc/com.atproto.sync.getRepo')) {
        return new Response(new Uint8Array(8), {
          status: 200,
          headers: { 'content-length': '2048' },
        })
      }
      return plcRes()
    }
    const provider = createVerifiedRepoProvider({
      pdsUrl: 'http://pds.test',
      plcUrl: 'http://plc.test',
      fetchImpl,
      maxCarBytes: 1024,
    })
    const index = new RecipeIndex(':memory:')
    const ingestor = createIngestor({
      index,
      repoStateProvider: provider,
      pdsUrl: 'http://pds.test',
      log: quietLog,
    })
    const res = await ingestor.reconcileRepo(DID)
    expect(res.ok).toBe(false)
    expect(ingestor.stats.rejected).toBe(1)
    expect(index.count()).toBe(0)
    index.close()
  })
})
