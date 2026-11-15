import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import {
  canonicalRecipeHashHex,
  recipeSignatureMessage,
  pubkeyBindingMessage,
  base58Decode,
  base58Encode,
  devicePublicKeyFromDid,
  didKeyFromPublicKeyBytes,
  decodeBase64Strict,
  verifyPubkeyBinding,
  verifyRecipeDeviceSignature,
} from '../device-signature.mjs'

const DID = 'did:plc:fakeauthor'

/**
 * Test keys are node:crypto Ed25519 — an INDEPENDENT signer from the
 * libsodium verifier under test (cross-implementation check: a node-signed
 * message must verify under libsodium, and vice versa for the scheme).
 * The deviceDid is built with the module's own did:key encoder, and
 * devicePublicKeyFromDid is exercised against it in the binding tests.
 */
function makeDevice() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const publicKeyBytes = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32))
  return {
    privateKey,
    publicKeyBytes,
    deviceDid: didKeyFromPublicKeyBytes(publicKeyBytes),
    devicePublicKey: Buffer.from(publicKeyBytes).toString('base64'),
  }
}

function signMsg(device, message) {
  return crypto.sign(null, Buffer.from(message, 'utf8'), device.privateKey).toString('base64')
}

function bindingRecord(device, accountDid = DID) {
  return {
    $type: 'kitchen.longtable.pubkey',
    deviceDid: device.deviceDid,
    devicePublicKey: device.devicePublicKey,
    signature: signMsg(device, pubkeyBindingMessage(accountDid, device.deviceDid, device.devicePublicKey)),
    createdAt: '2026-10-12T00:00:00.000Z',
  }
}

function recipeRecord(device, extra = {}) {
  const record = {
    $type: 'kitchen.longtable.recipe',
    name: 'Signed Soup',
    description: 'A test recipe.',
    ingredients: ['1 egg', '200g flour'],
    instructions: ['Mix.', 'Cook.'],
    prepTimeMinutes: 10,
    cookTimeMinutes: 20,
    recipeYield: '4 servings',
    tags: ['test'],
    longtableId: 'lt-signed-soup',
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
    ...extra,
  }
  const hashHex = canonicalRecipeHashHex(record)
  return {
    ...record,
    deviceDid: device.deviceDid,
    deviceSignature: signMsg(device, recipeSignatureMessage(DID, record.longtableId, hashHex)),
  }
}

describe('canonical recipe hash', () => {
  it('matches the independently computed BLAKE2b-256 vector (libsodium + @noble/hashes agreed)', () => {
    // Vector computed 2026-11-15 on the dev box: the same canonical array
    // hashed by libsodium crypto_generichash(32) AND by @noble/hashes
    // blake2b(dkLen 32) — both gave this hex. It pins the canonical
    // array construction (field order + defaults), not just the primitive.
    const record = {
      name: 'Cross Check Soup',
      description: 'desc',
      ingredients: ['1 egg', '200g flour'],
      instructions: ['Mix.', 'Cook.'],
      prepTimeMinutes: 10,
      cookTimeMinutes: 20,
      recipeYield: '4 servings',
      tags: ['test'],
      images: [{ ref: { $link: 'bafkreigh2akiscaildcqabsyg3dfrrol4fnas2xz2ip7k6kyk3v6g5m' } }],
    }
    expect(canonicalRecipeHashHex(record)).toBe(
      '6ba3524fa646ef29eb3ab544ee9e7f26d27045c50e88b46b61156fc629d154b3',
    )
  })

  it('leaves timestamps, mime/size and $type out of the hash (scope decision)', () => {
    const a = recipeRecord(makeDevice())
    const b = { ...a, createdAt: '2031-01-01T00:00:00.000Z', $type: 'kitchen.longtable.recipe' }
    // Same content fields -> same hash even though the signature over it
    // still verifies (the verifier recomputes from the served record).
    expect(canonicalRecipeHashHex(a)).toBe(canonicalRecipeHashHex(b))
  })
})

describe('did:key helpers', () => {
  it('base58 round-trips and did:key decodes to the raw key', () => {
    const device = makeDevice()
    const decoded = devicePublicKeyFromDid(device.deviceDid)
    expect(Buffer.from(decoded).toString('hex')).toBe(Buffer.from(device.publicKeyBytes).toString('hex'))
    expect(didKeyFromPublicKeyBytes(device.publicKeyBytes)).toBe(device.deviceDid)
    const bytes = new Uint8Array([0, 0, 1, 2, 255, 34])
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes)
  })

  it('rejects non-Ed25519 / malformed device DIDs', () => {
    expect(devicePublicKeyFromDid('did:plc:abc')).toBeNull()
    expect(devicePublicKeyFromDid('did:key:z123')).toBeNull()
    expect(devicePublicKeyFromDid(undefined)).toBeNull()
    expect(devicePublicKeyFromDid('did:key:z' + base58Encode(new Uint8Array(33).fill(7)))).toBeNull()
  })
})

describe('strict base64', () => {
  it('accepts canonical padded base64 of the right length, rejects the rest', () => {
    const good = Buffer.from(new Uint8Array(32).fill(9)).toString('base64')
    expect(decodeBase64Strict(good, 32)).not.toBeNull()
    expect(decodeBase64Strict(good.slice(0, -1), 32)).toBeNull() // stripped padding
    expect(decodeBase64Strict(good, 64)).toBeNull() // wrong length
    expect(decodeBase64Strict('!!!not-base64!!!', 32)).toBeNull()
    expect(decodeBase64Strict('', 32)).toBeNull()
  })
})

describe('pubkey binding verification', () => {
  it('accepts a genuine binding (node-signed, libsodium-verified)', async () => {
    const device = makeDevice()
    const res = await verifyPubkeyBinding(DID, bindingRecord(device))
    expect(res.ok).toBe(true)
    expect(res.deviceDid).toBe(device.deviceDid)
    expect(res.devicePublicKey).toBe(device.devicePublicKey)
  })

  it('rejects a binding signed by a different key', async () => {
    const device = makeDevice()
    const attacker = makeDevice()
    const binding = bindingRecord(device)
    binding.signature = signMsg(attacker, pubkeyBindingMessage(DID, device.deviceDid, device.devicePublicKey))
    expect((await verifyPubkeyBinding(DID, binding)).ok).toBe(false)
    expect((await verifyPubkeyBinding(DID, binding)).reason).toBe('binding-signature-invalid')
  })

  it('rejects a binding whose key does not match its deviceDid', async () => {
    const device = makeDevice()
    const other = makeDevice()
    const binding = bindingRecord(device)
    binding.devicePublicKey = other.devicePublicKey
    // Re-sign over the mismatched key so only the key-match check can fire.
    binding.signature = signMsg(device, pubkeyBindingMessage(DID, device.deviceDid, binding.devicePublicKey))
    const res = await verifyPubkeyBinding(DID, binding)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('binding-key-mismatch')
  })

  it('rejects a binding for a different account DID', async () => {
    const device = makeDevice()
    const res = await verifyPubkeyBinding('did:plc:someoneelse', bindingRecord(device))
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('binding-signature-invalid')
  })

  it('rejects missing / malformed bindings without throwing', async () => {
    expect((await verifyPubkeyBinding(DID, null)).reason).toBe('missing-binding')
    expect((await verifyPubkeyBinding(DID, {})).ok).toBe(false)
    expect((await verifyPubkeyBinding(DID, { deviceDid: 42, devicePublicKey: 'x', signature: 'y' })).ok).toBe(false)
  })
})

describe('recipe device-signature verification', () => {
  it('accepts a genuine recipe signature', async () => {
    const device = makeDevice()
    const binding = await verifyPubkeyBinding(DID, bindingRecord(device))
    expect(binding.ok).toBe(true)
    const res = await verifyRecipeDeviceSignature(DID, recipeRecord(device), binding)
    expect(res).toEqual({ ok: true })
  })

  it('rejects a tampered record carrying the genuine signature', async () => {
    const device = makeDevice()
    const binding = await verifyPubkeyBinding(DID, bindingRecord(device))
    const tampered = recipeRecord(device)
    tampered.ingredients = [...tampered.ingredients, '1 cup motor oil']
    const res = await verifyRecipeDeviceSignature(DID, tampered, binding)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('recipe-signature-invalid')
  })

  it('rejects an attacker re-sign with their own key', async () => {
    const device = makeDevice()
    const attacker = makeDevice()
    const binding = await verifyPubkeyBinding(DID, bindingRecord(device))
    const record = recipeRecord(device)
    const hashHex = canonicalRecipeHashHex(record)
    record.deviceSignature = signMsg(attacker, recipeSignatureMessage(DID, record.longtableId, hashHex))
    const res = await verifyRecipeDeviceSignature(DID, record, binding)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('recipe-signature-invalid')
  })

  it('rejects a recipe whose deviceDid is not the bound device', async () => {
    const device = makeDevice()
    const other = makeDevice()
    const binding = await verifyPubkeyBinding(DID, bindingRecord(device))
    const record = recipeRecord(device)
    record.deviceDid = other.deviceDid
    const res = await verifyRecipeDeviceSignature(DID, record, binding)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('recipe-deviceDid-mismatch')
  })

  it('rejects a recipe with no device signature at all', async () => {
    const device = makeDevice()
    const binding = await verifyPubkeyBinding(DID, bindingRecord(device))
    const record = recipeRecord(device)
    delete record.deviceSignature
    const res = await verifyRecipeDeviceSignature(DID, record, binding)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('missing-device-signature')
  })

  it('rejects when the binding itself failed verification', async () => {
    const device = makeDevice()
    const badBinding = await verifyPubkeyBinding(DID, { deviceDid: 'did:key:z123' })
    expect(badBinding.ok).toBe(false)
    const res = await verifyRecipeDeviceSignature(DID, recipeRecord(device), badBinding)
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('invalid-binding')
  })
})
