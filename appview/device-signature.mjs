/**
 * device-signature.mjs — device-signature verification for public recipes.
 *
 * The trust root of public recipes (review C2, 2026-11-15): the repo-commit
 * signature (verify.mjs) proves the PDS's repo state, but the PDS holds the
 * repo key and produces that signature — it proves nothing about the
 * *device* that authored the recipe. The device signature does:
 *
 *   1. The author's `kitchen.longtable.pubkey` binding records bind
 *      device keys to the account — one record per device (H-N1), at
 *      the rkey `pubkeyRkeyForDeviceDid(deviceDid)`; the legacy
 *      single-slot rkey `self` is still honored as one device's
 *      binding (migration). Each record carries `deviceDid` (a did:key),
 *      the same key as standard-base64 `devicePublicKey`, and
 *      `signature` — the device key's detached Ed25519 signature over
 *      `longtable-pubkey:v1\n<accountDid>\n<deviceDid>\n<devicePublicKey>`.
 *   2. Each recipe record carries `deviceDid` + `deviceSignature` — the
 *      detached Ed25519 signature over
 *      `longtable-recipe:v1\n<accountDid>\n<longtableId>\n<hashHex>`, where
 *      `hashHex` is the BLAKE2b-256 hex of the canonical JSON array
 *      (see canonicalRecipeHashHex). A recipe verifies against ITS OWN
 *      device's binding — a second device publishing never un-indexes
 *      the first device's recipes.
 *
 * This module is a port of the same checks in the independent verifier
 * (scripts/verify-public/verify-public.mjs) — same canonical hash, same
 * message strings, same libsodium primitives — so the AppView, the
 * signer (src/public/publish.ts) and the third-party verifier all agree
 * on what a valid signature is. It is the ONLY place that knows the
 * device-signature scheme; ingest.mjs calls it, db.mjs only stores its
 * inputs/outputs.
 *
 * All verification is fail-closed: any malformed field, length mismatch
 * or bad signature returns { ok: false, reason } — never throws for bad
 * input. (libsodium itself is the one dependency; see package.json.)
 */
import sodium from 'libsodium-wrappers'

/** The pubkey binding collection (same literal as db.mjs). */
const PUBKEY_COLLECTION = 'kitchen.longtable.pubkey'

// libsodium's crypto functions are attached only once the WASM module has
// loaded: `sodium.ready` MUST resolve before any synchronous export in this
// module (canonicalRecipeHashHex, decodeBase64Strict) is called. Awaiting
// it at module top level makes the import itself wait, so every importer -
// sync or async, test or production - sees initialized sodium. (The async
// verify functions used to be the only callers of ready(); the sync
// functions raced WASM init and failed on fast runs with
// "crypto_generichash is not a function".)
await sodium.ready

async function ready() {
  await sodium.ready
}

/* ---------------- canonical hash (== publish.ts / verify-public) -------- */

/** The image $link strings of a record, in order (canonical-hash input). */
function imageCid(img) {
  const ref = img?.ref
  if (!ref) return ''
  if (typeof ref.$link === 'string') return ref.$link
  return String(ref)
}

/**
 * Canonical recipe hash: BLAKE2b-256 hex over the JSON canonical array.
 * Field order and defaults are load-bearing — they must match
 * publish.ts `canonicalRecipeHash` exactly: timestamps, mime/size and
 * $type are NOT in the hash (scope decision: changing the message format
 * is out of scope for the C2 fix).
 */
export function canonicalRecipeHashHex(record) {
  const canonical = JSON.stringify([
    record.name,
    record.description || '',
    record.ingredients,
    record.instructions,
    record.prepTimeMinutes ?? null,
    record.cookTimeMinutes ?? null,
    record.recipeYield || '',
    record.tags || [],
    (record.images || []).map(imageCid),
  ])
  const hash = sodium.crypto_generichash(32, sodium.from_string(canonical))
  return sodium.to_hex(hash)
}

/** The exact UTF-8 payload signed for a recipe record. */
export function recipeSignatureMessage(accountDid, longtableId, hashHex) {
  return `longtable-recipe:v1\n${accountDid}\n${longtableId}\n${hashHex}`
}

/** The exact UTF-8 payload signed for the pubkey binding record. */
export function pubkeyBindingMessage(accountDid, deviceDid, devicePublicKeyBase64) {
  return `longtable-pubkey:v1\n${accountDid}\n${deviceDid}\n${devicePublicKeyBase64}`
}

/**
 * The per-device rkey for a device's pubkey binding record (H-N1) —
 * the AppView half of the same scheme as the client's
 * `pubkeyRkeyForDeviceDid` in src/public/publish.ts (same hash, same
 * truncation, same `dev-` prefix; both pin the same test vector).
 * Returns null for a non-string input (never throws for bad input).
 */
export function pubkeyRkeyForDeviceDid(deviceDid) {
  if (typeof deviceDid !== 'string' || deviceDid.length === 0) return null
  const hashHex = sodium.to_hex(
    sodium.crypto_generichash(32, sodium.from_string(deviceDid)),
  )
  return `dev-${hashHex.slice(0, 32)}`
}

/* ---------------- base58btc (did:key multibase) -------------------------- */

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

/** Decode base58btc (== verify-public.mjs). Throws on a bad character. */
export function base58Decode(str) {
  const bytes = [0]
  for (const ch of str) {
    const idx = B58.indexOf(ch)
    if (idx < 0) throw new Error(`bad base58 char ${ch}`)
    let carry = idx
    for (let i = 0; i < bytes.length; i++) {
      const v = bytes[i] * 58 + carry
      bytes[i] = v & 0xff
      carry = v >> 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  let zeros = 0
  while (zeros < str.length && str[zeros] === '1') zeros++
  const out = new Uint8Array(zeros + bytes.length)
  out.set(bytes.reverse(), zeros)
  return out
}

/** Encode base58btc. Used by tests/e2e to build a did:key from raw bytes. */
export function base58Encode(bytes) {
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  let s = ''
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s
    n /= 58n
  }
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  return '1'.repeat(zeros) + (s || '')
}

/**
 * The raw 32-byte Ed25519 public key for a did:key, or null if the DID is
 * not an Ed25519 did:key. did:key payload is multicodec 0xed 0x01 + key.
 */
export function devicePublicKeyFromDid(deviceDid) {
  try {
    if (typeof deviceDid !== 'string' || !deviceDid.startsWith('did:key:z')) return null
    const raw = base58Decode(deviceDid.slice('did:key:z'.length))
    if (raw[0] !== 0xed || raw[1] !== 0x01 || raw.length !== 34) return null
    return raw.slice(2)
  } catch {
    return null
  }
}

/** The did:key for a raw 32-byte Ed25519 public key. */
export function didKeyFromPublicKeyBytes(publicKeyBytes) {
  const prefixed = new Uint8Array(34)
  prefixed[0] = 0xed
  prefixed[1] = 0x01
  prefixed.set(publicKeyBytes, 2)
  return `did:key:z${base58Encode(prefixed)}`
}

/* ---------------- strict base64 ------------------------------------------ */

/**
 * Decode standard (padded) base64, strictly: the value must round-trip
 * through re-encoding, and the decoded length must match. The signer
 * (publish.ts, libsodium u8ToBase64) always emits canonical padded
 * base64, so anything else is not a signature this device produced.
 * Returns the bytes, or null.
 */
export function decodeBase64Strict(value, expectedLength) {
  if (typeof value !== 'string' || value.length === 0) return null
  try {
    const bytes = sodium.from_base64(value, sodium.base64_variants.ORIGINAL)
    if (bytes.length !== expectedLength) return null
    if (sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL) !== value) return null
    return bytes
  } catch {
    return null
  }
}

/* ---------------- verification ------------------------------------------- */

/**
 * Verify a `kitchen.longtable.pubkey` binding record for `accountDid`.
 * The record may sit at any accepted rkey (see verifyPubkeyBindings) —
 * the rkey is an address, not part of the signed payload. Returns
 * { ok: true, deviceDid, devicePublicKey, devicePublicKeyBytes }
 * or { ok: false, reason }. Checks, in order: the binding's key field
 * decodes to 32 bytes; its deviceDid is an Ed25519 did:key for exactly
 * those bytes; the binding signature (64 bytes) verifies against the
 * device key over the binding message.
 */
export async function verifyPubkeyBinding(accountDid, binding) {
  await ready()
  if (!binding || typeof binding !== 'object') {
    return { ok: false, reason: 'missing-binding' }
  }
  const keyBytes = decodeBase64Strict(binding.devicePublicKey, 32)
  if (!keyBytes) return { ok: false, reason: 'invalid-binding-key' }
  const didKeyBytes = devicePublicKeyFromDid(binding.deviceDid)
  if (!didKeyBytes) return { ok: false, reason: 'invalid-binding-deviceDid' }
  if (sodium.to_hex(keyBytes) !== sodium.to_hex(didKeyBytes)) {
    return { ok: false, reason: 'binding-key-mismatch' }
  }
  const sig = decodeBase64Strict(binding.signature, 64)
  if (!sig) return { ok: false, reason: 'invalid-binding-signature' }
  let ok = false
  try {
    ok = sodium.crypto_sign_verify_detached(
      sig,
      sodium.from_string(pubkeyBindingMessage(accountDid, binding.deviceDid, binding.devicePublicKey)),
      keyBytes,
    )
  } catch {
    /* verification threw; ok stays false */
  }
  if (!ok) return { ok: false, reason: 'binding-signature-invalid' }
  return {
    ok: true,
    deviceDid: binding.deviceDid,
    devicePublicKey: binding.devicePublicKey,
    devicePublicKeyBytes: keyBytes,
  }
}

/**
 * Verify ALL pubkey binding records in a verified repo state (H-N1).
 *
 * `records` are the `{ collection, rkey, cid, record }` entries of one
 * account's verified repo state. Returns:
 *   { bindings, candidates, firstInvalidReason, ignoredRkeys }
 * where `bindings` is a Map from deviceDid to its verified binding
 * ({ ok: true, ... } as returned by verifyPubkeyBinding), `candidates`
 * counts the pubkey records at an accepted rkey, `firstInvalidReason`
 * is the first candidate's failure reason (null when every candidate
 * verified, or when there were no candidates), and `ignoredRkeys`
 * lists pubkey records at an rkey that is neither the legacy `self`
 * nor the device's own per-device rkey — those are not bindings at
 * all (the rkey is bound to the record's deviceDid, so a record at a
 * stray rkey cannot stand in for a device's binding).
 *
 * Rules:
 * - Accepted rkeys: `self` (legacy migration — the pre-H-N1 single
 *   slot, honored as one device's binding so existing published
 *   recipes keep verifying) or `pubkeyRkeyForDeviceDid(deviceDid)`.
 * - Two valid bindings naming the same deviceDid (e.g. `self` plus
 *   the per-device record, after a client upgrade) are equivalent —
 *   the deviceDid determines the key — so the first one wins.
 * - A deviceDid is the key: two different keys can never share one.
 */
export async function verifyPubkeyBindings(accountDid, records) {
  await ready()
  const bindings = new Map()
  const ignoredRkeys = []
  let candidates = 0
  let firstInvalidReason = null
  for (const entry of records ?? []) {
    if (entry?.collection !== PUBKEY_COLLECTION) continue
    const record = entry.record
    const rkey = entry.rkey
    const derived = pubkeyRkeyForDeviceDid(record?.deviceDid)
    if (rkey !== 'self' && rkey !== derived) {
      ignoredRkeys.push(rkey)
      continue
    }
    candidates++
    const checked = await verifyPubkeyBinding(accountDid, record)
    if (!checked.ok) {
      if (firstInvalidReason === null) firstInvalidReason = checked.reason
      continue
    }
    if (!bindings.has(checked.deviceDid)) bindings.set(checked.deviceDid, checked)
  }
  return { bindings, candidates, firstInvalidReason, ignoredRkeys }
}

/**
 * Verify one recipe record against an already-verified binding (the
 * { ok: true, ... } result of verifyPubkeyBinding). Returns { ok: true }
 * or { ok: false, reason }. Checks: the record's deviceDid is the bound
 * device; the record has a well-formed 64-byte deviceSignature; the
 * signature verifies against the bound key over the recipe message for
 * the recomputed canonical hash of the record AS SERVED (so any content
 * change after signing fails).
 */
export async function verifyRecipeDeviceSignature(accountDid, record, binding) {
  await ready()
  if (!binding?.ok) return { ok: false, reason: 'invalid-binding' }
  if (!record || typeof record !== 'object') {
    return { ok: false, reason: 'missing-record' }
  }
  if (typeof record.longtableId !== 'string' || record.longtableId.length === 0) {
    return { ok: false, reason: 'missing-longtableId' }
  }
  if (record.deviceDid !== binding.deviceDid) {
    return { ok: false, reason: 'recipe-deviceDid-mismatch' }
  }
  const sig = decodeBase64Strict(record.deviceSignature, 64)
  if (!sig) return { ok: false, reason: 'missing-device-signature' }
  let hashHex
  try {
    hashHex = canonicalRecipeHashHex(record)
  } catch {
    return { ok: false, reason: 'unhashable-record' }
  }
  let ok = false
  try {
    ok = sodium.crypto_sign_verify_detached(
      sig,
      sodium.from_string(recipeSignatureMessage(accountDid, record.longtableId, hashHex)),
      binding.devicePublicKeyBytes,
    )
  } catch {
    /* verification threw; ok stays false */
  }
  return ok ? { ok: true } : { ok: false, reason: 'recipe-signature-invalid' }
}
