/**
 * signed-fixtures.mjs — shared signing helpers for the AppView tests.
 *
 * Test devices are node:crypto Ed25519 keypairs — an INDEPENDENT signer
 * from the libsodium verifier under test — so a passing test proves the
 * two implementations agree on the scheme, not just that the module
 * agrees with itself.
 */
import crypto from 'node:crypto'
import {
  canonicalRecipeHashHex,
  recipeSignatureMessage,
  pubkeyBindingMessage,
  didKeyFromPublicKeyBytes,
} from '../device-signature.mjs'

export function makeDevice() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const publicKeyBytes = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32))
  return {
    privateKey,
    publicKeyBytes,
    deviceDid: didKeyFromPublicKeyBytes(publicKeyBytes),
    devicePublicKey: Buffer.from(publicKeyBytes).toString('base64'),
  }
}

export function signMsg(device, message) {
  return crypto.sign(null, Buffer.from(message, 'utf8'), device.privateKey).toString('base64')
}

/** A valid `kitchen.longtable.pubkey/self` binding record for `device`. */
export function bindingRecord(device, accountDid) {
  return {
    $type: 'kitchen.longtable.pubkey',
    deviceDid: device.deviceDid,
    devicePublicKey: device.devicePublicKey,
    signature: signMsg(
      device,
      pubkeyBindingMessage(accountDid, device.deviceDid, device.devicePublicKey),
    ),
    createdAt: '2026-10-12T00:00:00.000Z',
  }
}

/** A valid device-signed recipe record (same shape as the ingest tests' record()). */
export function signedRecipeRecord(device, accountDid, name, ingredients, extra = {}) {
  const record = {
    $type: 'kitchen.longtable.recipe',
    name,
    ingredients,
    instructions: ['Cook it.'],
    longtableId: `lt-${name.toLowerCase().replaceAll(' ', '-')}`,
    createdAt: '2026-10-12T00:00:00.000Z',
    updatedAt: '2026-10-12T00:00:00.000Z',
    ...extra,
  }
  const hashHex = canonicalRecipeHashHex(record)
  return {
    ...record,
    deviceDid: device.deviceDid,
    deviceSignature: signMsg(device, recipeSignatureMessage(accountDid, record.longtableId, hashHex)),
  }
}
