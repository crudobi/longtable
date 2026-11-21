#!/usr/bin/env node
/**
 * verify-public.mjs — INDEPENDENT verifier for Longtable public records.
 *
 * Uses only official ATProto libraries (@atproto/repo, @atproto/common,
 * @atproto/crypto, @atproto/lexicon) + libsodium — none of the Longtable
 * app/client/AppView code. This is the "third-party verifier" of the
 * Phase 3 oath: "A public recipe is anyone's to find, nobody's to forge."
 *
 * Modes:
 *   verify <did> <rkey>         Full verification of one published recipe:
 *                               repo commit signature (vs DID doc key),
 *                               lexicon validity, pubkey binding signature,
 *                               recipe device signature.
 *   audit <did>                 List every record in the DID's verified repo
 *                               (privacy audit: what actually left the device).
 *   forge-selftest <did> <rkey> Take the genuine record, forge its device
 *                               signature with a fresh attacker key, and
 *                               tamper with its contents — both forgeries
 *                               must FAIL verification.
 *   binding <did> <rkey>        Print (one JSON line) the pubkey binding
 *                               for the recipe's own device: its rkey,
 *                               deviceDid and devicePublicKey. Read-only
 *                               lookup for proofs — resolves the binding
 *                               by deviceDid from the verified repo CAR,
 *                               never by the legacy `self` rkey (H-N1:
 *                               clients bind per device and never write
 *                               `self`).
 *   record <did> <rkey>         Print (one JSON line) one recipe record
 *                               from the verified repo CAR. Read-only
 *                               lookup for proofs: the verified snapshot
 *                               the other modes check against.
 *
 * Env: PLC_URL (default http://localhost:2582), PDS_URL (default
 * http://localhost:2583), LEXICONS_DIR (default ../../lexicons).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sodium from 'libsodium-wrappers'
import { Lexicons } from '@atproto/lexicon'
import {
  verifyRepoCar,
  readCarWithRoot,
  MemoryBlockstore,
  MST,
  getAndParseRecord,
  parseDataKey,
  def,
} from '@atproto/repo'
import { getSigningDidKey } from '@atproto/common'
import { parseDidKey, formatDidKey, multibaseToBytes } from '@atproto/crypto'

const PLC_URL = process.env.PLC_URL || 'http://localhost:2582'
const PDS_URL = process.env.PDS_URL || 'http://localhost:2583'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const LEXICONS_DIR = process.env.LEXICONS_DIR || path.join(HERE, '..', '..', 'lexicons')

let failures = 0
function pass(name, detail = '') {
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`)
}
function fail(name, detail = '') {
  failures += 1
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
}

/* ---------------- DID resolution + verified repo state ------------------ */

// Extract the repo signing key as a did:key. Modern DID docs work via
// getSigningDidKey; some PLC deployments emit the legacy
// EcdsaSecp256k1VerificationKey2019 shape whose publicKeyMultibase is the
// raw key bytes with no multicodec prefix — re-wrap those with formatDidKey
// (format normalization only; signature verification is unaffected and a
// wrong guess fails closed inside verifyRepoCar).
function extractSigningDidKey(didDoc) {
  try {
    const via = getSigningDidKey(didDoc)
    if (via) {
      parseDidKey(via)
      return via
    }
  } catch {
    /* fall through */
  }
  const methods = Array.isArray(didDoc?.verificationMethod) ? didDoc.verificationMethod : []
  const vm = methods.find((m) => typeof m?.id === 'string' && m.id.endsWith('#atproto')) ?? methods[0]
  const mb = vm?.publicKeyMultibase
  if (!mb) return undefined
  try {
    parseDidKey(`did:key:${mb}`)
    return `did:key:${mb}`
  } catch {
    /* legacy raw key */
  }
  let raw
  try {
    raw = multibaseToBytes(mb)
  } catch {
    return undefined
  }
  const type = String(vm?.type ?? '')
  const order = []
  if (/secp256k1/i.test(type)) order.push('ES256K')
  if (/secp256r1|p-?256/i.test(type)) order.push('ES256')
  if (/ed25519/i.test(type)) order.push('EdDSA')
  for (const a of ['ES256K', 'ES256', 'EdDSA']) if (!order.includes(a)) order.push(a)
  for (const alg of order) {
    if (alg === 'EdDSA' && raw.length !== 32) continue
    if (alg !== 'EdDSA' && raw.length !== 33 && raw.length !== 65) continue
    try {
      const candidate = formatDidKey(alg, raw)
      parseDidKey(candidate)
      return candidate
    } catch {
      /* try next */
    }
  }
  return undefined
}

async function loadVerifiedRepo(did) {
  const docRes = await fetch(`${PLC_URL}/${did}`)
  if (!docRes.ok) throw new Error(`DID resolution failed: HTTP ${docRes.status}`)
  const doc = await docRes.json()
  if (doc?.id !== did) throw new Error('DID document id mismatch')
  const signingKey = extractSigningDidKey(doc)
  if (!signingKey) throw new Error('no #atproto signing key in DID document')

  const res = await fetch(`${PDS_URL}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(did)}`)
  if (!res.ok) throw new Error(`getRepo failed: HTTP ${res.status}`)
  const carBytes = new Uint8Array(await res.arrayBuffer())
  // Throws unless the commit signature verifies against the DID doc key.
  const verified = await verifyRepoCar(carBytes, did, signingKey)
  const verifiedCids = new Set(verified.creates.map((c) => c.cid.toString()))

  const { root, blocks } = await readCarWithRoot(carBytes)
  const blockstore = new MemoryBlockstore(blocks)
  const commit = await blockstore.readObj(root, def.commit)
  if (commit.did !== did) throw new Error('repo DID mismatch')
  const mst = MST.load(blockstore, commit.data)
  const leaves = await mst.reachableLeaves()
  const records = []
  for (const leaf of leaves) {
    const cid = leaf.value.toString()
    if (!verifiedCids.has(cid)) throw new Error(`record ${leaf.key} not in verified creates`)
    const { collection, rkey } = parseDataKey(leaf.key)
    const { record } = await getAndParseRecord(blocks, leaf.value)
    records.push({ collection, rkey, cid, record })
  }
  return { signingKey, records }
}

/* ---------------- device-key helpers (did:key, Ed25519) ------------------ */

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58Decode(str) {
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

function devicePublicKeyFromDid(deviceDid) {
  if (!deviceDid.startsWith('did:key:z')) throw new Error(`not a did:key: ${deviceDid}`)
  const raw = base58Decode(deviceDid.slice('did:key:z'.length))
  if (raw[0] !== 0xed || raw[1] !== 0x01 || raw.length !== 34) {
    throw new Error('unexpected did:key payload for Ed25519')
  }
  return raw.slice(2)
}

// L-N4: every image ref must be a {$link} blob reference carrying a
// string CID. Anything else throws — the signer never emits that shape,
// so a record carrying one has no well-defined hash. Callers treat the
// throw as a verification failure, never as a crash: modeVerify wraps
// the signature check (see below), so a malformed record FAILs the
// check instead of aborting the audit.
function imageCid(img) {
  const ref = img?.ref
  if (!ref) throw new Error('image ref is not a {$link} blob reference')
  if (typeof ref.$link === 'string' && ref.$link) return ref.$link
  throw new Error('image ref is not a {$link} blob reference')
}

function canonicalHashHex(record) {
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

// Sec L11: the signed message is v2 (bound to the record's createdAt),
// with a v1 fallback for records published before v2. A v2 signature
// never verifies under v1 (the messages differ), so accepting v1 cannot
// downgrade a v2-signed record — it only keeps old publications
// verifiable. Returns false (never throws) for an unverifiable record,
// including one whose hash cannot be computed (L-N4).
function verifyDeviceSignature(record, accountDid, devicePubKey) {
  let hashHex
  try {
    hashHex = canonicalHashHex(record)
  } catch {
    return false
  }
  let sig
  try {
    sig = sodium.from_base64(record.deviceSignature, sodium.base64_variants.ORIGINAL)
  } catch {
    return false
  }
  const messages = []
  if (typeof record.createdAt === 'string' && record.createdAt) {
    messages.push(
      `longtable-recipe:v2\n${accountDid}\n${record.longtableId}\n${hashHex}\n${record.createdAt}`,
    )
  }
  messages.push(`longtable-recipe:v1\n${accountDid}\n${record.longtableId}\n${hashHex}`)
  for (const msg of messages) {
    try {
      if (sodium.crypto_sign_verify_detached(sig, sodium.from_string(msg), devicePubKey)) {
        return true
      }
    } catch {
      // A verify that throws is a failed verify, not a pass.
    }
  }
  return false
}

/* ---------------- modes --------------------------------------------------- */

function finish() {
  console.log(failures === 0 ? 'VERIFY RESULT: ALL PASS' : `VERIFY RESULT: ${failures} FAILURE(S)`)
  return failures === 0 ? 0 : 1
}

async function modeVerify(did, rkey) {
  await sodium.ready
  const lex = new Lexicons([
    JSON.parse(fs.readFileSync(path.join(LEXICONS_DIR, 'kitchen.longtable.recipe.json'), 'utf8')),
    JSON.parse(fs.readFileSync(path.join(LEXICONS_DIR, 'kitchen.longtable.pubkey.json'), 'utf8')),
  ])
  const { signingKey, records } = await loadVerifiedRepo(did)
  pass('repo commit signature verifies against DID document key', signingKey.slice(0, 24) + '…')

  const recipeEntry = records.find((r) => r.collection === 'kitchen.longtable.recipe' && r.rkey === rkey)
  if (!recipeEntry) {
    fail('recipe record present in verified repo', `rkey ${rkey} not found`)
    return finish()
  }
  pass('recipe record present in verified repo', recipeEntry.cid.slice(0, 16) + '…')
  const record = recipeEntry.record
  try {
    lex.assertValidRecord('kitchen.longtable.recipe', record)
    pass('recipe record is lexicon-valid')
  } catch (e) {
    fail('recipe record is lexicon-valid', String(e).split('\n')[0])
  }

  // Per-device bindings (H-N1): the binding for THIS recipe's device —
  // any rkey (the per-device rkey, or the legacy `self` record as
  // migration) — not just the record at `self`.
  const pubkeyEntry = records.find(
    (r) => r.collection === 'kitchen.longtable.pubkey' && r.record?.deviceDid === record.deviceDid,
  )
  if (!pubkeyEntry) {
    fail('pubkey binding record present')
    return finish()
  }
  pass('pubkey binding record present')
  const pk = pubkeyEntry.record
  try {
    lex.assertValidRecord('kitchen.longtable.pubkey', pk)
    pass('pubkey record is lexicon-valid')
  } catch (e) {
    fail('pubkey record is lexicon-valid', String(e).split('\n')[0])
  }

  let devicePubKey
  try {
    devicePubKey = devicePublicKeyFromDid(pk.deviceDid)
    const recordKey = sodium.from_base64(pk.devicePublicKey, sodium.base64_variants.ORIGINAL)
    if (sodium.to_hex(recordKey) !== sodium.to_hex(devicePubKey)) {
      fail('pubkey record key matches deviceDid')
      return finish()
    }
    pass('pubkey record key matches deviceDid')
  } catch (e) {
    fail('decode deviceDid', String(e).split('\n')[0])
    return finish()
  }

  const bindingMsg = `longtable-pubkey:v1\n${did}\n${pk.deviceDid}\n${pk.devicePublicKey}`
  const bindingOk = sodium.crypto_sign_verify_detached(
    sodium.from_base64(pk.signature, sodium.base64_variants.ORIGINAL),
    sodium.from_string(bindingMsg),
    devicePubKey,
  )
  if (bindingOk) pass('pubkey binding signature verifies (device authorized this account)')
  else fail('pubkey binding signature verifies')

  if (record.deviceDid !== pk.deviceDid) {
    fail('recipe deviceDid matches bound device')
  } else {
    pass('recipe deviceDid matches bound device')
  }
  if (verifyDeviceSignature(record, did, devicePubKey)) {
    pass('recipe device signature verifies', `name="${record.name}"`)
  } else {
    fail('recipe device signature verifies')
  }
  return finish()
}

async function modeAudit(did) {
  const { records } = await loadVerifiedRepo(did)
  for (const r of records) {
    const label = r.collection === 'kitchen.longtable.recipe' ? ` name="${r.record.name}"` : ''
    console.log(`RECORD ${r.collection}/${r.rkey}${label}`)
  }
  console.log(`TOTAL ${records.length}`)
  return 0
}

// Read-only lookups for proofs (H-N1): resolve a recipe's own device
// binding — or the recipe record itself — from the verified repo CAR,
// the same ground truth `verify` uses. The binding is found by deviceDid,
// at whatever rkey it lives at (the per-device rkey, or the legacy `self`
// record as migration) — never by assuming the `self` rkey.
async function modeBinding(did, rkey) {
  await sodium.ready
  const { records } = await loadVerifiedRepo(did)
  const entry = records.find((r) => r.collection === 'kitchen.longtable.recipe' && r.rkey === rkey)
  if (!entry) {
    console.error(`binding: recipe ${rkey} not found in verified repo`)
    return 1
  }
  const pubkeyEntry = records.find(
    (r) => r.collection === 'kitchen.longtable.pubkey' && r.record?.deviceDid === entry.record.deviceDid,
  )
  if (!pubkeyEntry) {
    console.error(`binding: no pubkey binding for device ${entry.record.deviceDid} in verified repo`)
    return 1
  }
  console.log(
    JSON.stringify({
      rkey: pubkeyEntry.rkey,
      deviceDid: pubkeyEntry.record.deviceDid,
      devicePublicKey: pubkeyEntry.record.devicePublicKey,
    }),
  )
  return 0
}

async function modeRecord(did, rkey) {
  await sodium.ready
  const { records } = await loadVerifiedRepo(did)
  const entry = records.find((r) => r.collection === 'kitchen.longtable.recipe' && r.rkey === rkey)
  if (!entry) {
    console.error(`record: recipe ${rkey} not found in verified repo`)
    return 1
  }
  console.log(JSON.stringify(entry.record))
  return 0
}

async function modeForgeSelftest(did, rkey) {
  await sodium.ready
  const { records } = await loadVerifiedRepo(did)
  const entry = records.find((r) => r.collection === 'kitchen.longtable.recipe' && r.rkey === rkey)
  if (!entry) {
    fail('genuine record found for forge selftest')
    return finish()
  }
  const record = entry.record
  const pk = records.find((r) => r.collection === 'kitchen.longtable.pubkey' && r.record?.deviceDid === record.deviceDid)?.record
  if (!pk) {
    fail('pubkey binding for the recipe device found (selftest precondition)')
    return finish()
  }
  const devicePubKey = devicePublicKeyFromDid(pk.deviceDid)
  if (!verifyDeviceSignature(record, did, devicePubKey)) {
    fail('genuine signature verifies before forging (selftest precondition)')
    return finish()
  }
  pass('genuine signature verifies (selftest precondition)')

  // Forge 1: attacker re-signs the genuine content with THEIR key, over
  // the current (v2) message — the shape a real attacker would forge
  // today. The key is wrong, so it must fail under both messages.
  const attacker = sodium.crypto_sign_keypair()
  const msg = sodium.from_string(
    `longtable-recipe:v2\n${did}\n${record.longtableId}\n${canonicalHashHex(record)}\n${record.createdAt}`,
  )
  const forgedSig = sodium.crypto_sign_detached(msg, attacker.privateKey)
  if (!sodium.crypto_sign_verify_detached(forgedSig, msg, devicePubKey)) {
    pass('forged signature (attacker key, author DID) REJECTED')
  } else {
    fail('forged signature (attacker key, author DID) was ACCEPTED')
  }

  // Forge 2: tamper with content, keep the genuine signature.
  const tampered = { ...record, ingredients: [...record.ingredients, '1 cup motor oil'] }
  if (!verifyDeviceSignature(tampered, did, devicePubKey)) {
    pass('tampered record (genuine signature, altered content) REJECTED')
  } else {
    fail('tampered record was ACCEPTED')
  }
  return finish()
}

const [mode, did, rkey] = process.argv.slice(2)
try {
  let code
  if (mode === 'verify') code = await modeVerify(did, rkey)
  else if (mode === 'audit') code = await modeAudit(did)
  else if (mode === 'forge-selftest') code = await modeForgeSelftest(did, rkey)
  else if (mode === 'binding') code = await modeBinding(did, rkey)
  else if (mode === 'record') code = await modeRecord(did, rkey)
  else {
    console.error('usage: verify-public.mjs <verify|audit|forge-selftest|binding|record> <did> [rkey]')
    code = 2
  }
  process.exit(code)
} catch (e) {
  console.error(`ERROR ${e?.stack || e}`)
  process.exit(1)
}
