#!/usr/bin/env node
/**
 * read-recipe.mjs — a third-party Longtable client in ~250 lines.
 *
 * Written from docs/public-protocol.md alone. It uses only official
 * ATProto libraries (@atproto/repo, @atproto/common, @atproto/crypto)
 * and libsodium — NONE of the Longtable app's code. It implements the
 * documented read + verify flow:
 *
 *   1. Find a public recipe through an AppView search.
 *   2. Resolve the author's DID document (signing key + PDS endpoint).
 *   3. Fetch the pubkey binding + recipe records from the author's PDS.
 *   4. Verify the repo export (commit signature; record CID present).
 *   5. Verify the device-key binding signature.
 *   6. Verify the recipe's device signature over its canonical hash.
 *
 * Usage:
 *   node read-recipe.mjs <search text>          e.g. node read-recipe.mjs soup
 *   node read-recipe.mjs --did <did> --rkey <rkey>
 *
 * Env: APPVIEW_URL (default http://localhost:3210),
 *      PLC_URL (default http://localhost:2582),
 *      PDS_URL (default: taken from the DID document's PDS endpoint).
 */
import sodium from 'libsodium-wrappers'
import { verifyRepoCar } from '@atproto/repo'
import { getSigningDidKey } from '@atproto/common'
import { formatDidKey, parseDidKey, multibaseToBytes } from '@atproto/crypto'

const APPVIEW_URL = (process.env.APPVIEW_URL || 'http://localhost:3210').replace(/\/+$/, '')
const PLC_URL = (process.env.PLC_URL || 'http://localhost:2582').replace(/\/+$/, '')

let failures = 0
const pass = (name, detail = '') => console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`)
const fail = (name, detail = '') => {
  failures += 1
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
}
const check = (name, fn) => {
  try {
    const detail = fn()
    pass(name, typeof detail === 'string' ? detail : '')
    return true
  } catch (e) {
    fail(name, String(e?.message ?? e).split('\n')[0])
    return false
  }
}

async function getJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`)
  return res.json()
}

/* Step 2 helper: the testnet PLC emits a legacy DID-doc shape whose
 * publicKeyMultibase lacks the multicodec prefix @atproto/crypto wants;
 * re-wrap it (normalization only — verification still fails closed). */
function extractSigningDidKey(didDoc) {
  try {
    const via = getSigningDidKey(didDoc)
    if (via) {
      parseDidKey(via)
      return via
    }
  } catch { /* fall through */ }
  const methods = Array.isArray(didDoc?.verificationMethod) ? didDoc.verificationMethod : []
  const vm = methods.find((m) => typeof m?.id === 'string' && m.id.endsWith('#atproto')) ?? methods[0]
  const mb = vm?.publicKeyMultibase
  if (!mb) return undefined
  try {
    parseDidKey(`did:key:${mb}`)
    return `did:key:${mb}`
  } catch { /* legacy raw key */ }
  let raw
  try { raw = multibaseToBytes(mb) } catch { return undefined }
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
    } catch { /* try next */ }
  }
  return undefined
}

function pdsEndpointFromDoc(didDoc) {
  const services = Array.isArray(didDoc?.service) ? didDoc.service : []
  const pds = services.find((s) => String(s?.id ?? '').endsWith('#atproto_pds'))
  return typeof pds?.serviceEndpoint === 'string' ? pds.serviceEndpoint.replace(/\/+$/, '') : null
}

/* Canonical recipe hash + signature strings, exactly as the protocol
 * doc specifies (BLAKE2b-256 over the canonical JSON array). */
function canonicalHashHex(record) {
  const imageCids = (record.images || []).map((img) => {
    const ref = img?.ref
    if (!ref) return ''
    return typeof ref.$link === 'string' ? ref.$link : String(ref)
  })
  const canonical = JSON.stringify([
    record.name,
    record.description || '',
    record.ingredients,
    record.instructions,
    record.prepTimeMinutes ?? null,
    record.cookTimeMinutes ?? null,
    record.recipeYield || '',
    record.tags || [],
    imageCids,
  ])
  return sodium.to_hex(sodium.crypto_generichash(32, sodium.from_string(canonical)))
}

const verifyDetached = (sigB64, message, pubKeyBytes) =>
  sodium.crypto_sign_verify_detached(
    sodium.from_base64(sigB64, sodium.base64_variants.ORIGINAL),
    sodium.from_string(message),
    pubKeyBytes,
  )

async function main() {
  await sodium.ready
  const args = process.argv.slice(2)
  let did, rkey

  /* ---- Step 1: find the recipe through the AppView (a hint, not truth) */
  const didFlag = args.indexOf('--did')
  if (didFlag >= 0) {
    did = args[didFlag + 1]
    rkey = args[args.indexOf('--rkey') + 1]
    if (!did || !rkey) throw new Error('usage: --did <did> --rkey <rkey>')
    console.log(`Target: ${did} / ${rkey} (given directly)`)
  } else {
    const q = args.join(' ').trim()
    if (!q) throw new Error('usage: node read-recipe.mjs <search text>')
    const { results } = await getJson(`${APPVIEW_URL}/search?q=${encodeURIComponent(q)}`)
    if (!Array.isArray(results) || results.length === 0) {
      console.log(`No public recipes matched "${q}" on ${APPVIEW_URL}.`)
      process.exit(2)
    }
    ;({ did, rkey } = results[0])
    pass('AppView search found a recipe', `"${results[0].name}" by ${did}`)
  }

  /* ---- Step 2: resolve the author's DID document */
  const didDoc = await getJson(`${PLC_URL}/${encodeURIComponent(did)}`)
  if (didDoc?.id !== did) throw new Error('DID document id mismatch')
  const signingKey = extractSigningDidKey(didDoc)
  if (!signingKey) throw new Error('no #atproto signing key in DID document')
  const pdsUrl = (process.env.PDS_URL || pdsEndpointFromDoc(didDoc) || '').replace(/\/+$/, '')
  if (!pdsUrl) throw new Error('no PDS endpoint in DID document (set PDS_URL)')
  pass('DID resolved', `PDS ${pdsUrl}`)

  /* ---- Step 3: fetch the records from the author's PDS */
  const getRecord = async (collection, key) => {
    const url =
      `${pdsUrl}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}` +
      `&collection=${encodeURIComponent(collection)}&rkey=${encodeURIComponent(key)}`
    return getJson(url)
  }
  const pubkeyRes = await getRecord('kitchen.longtable.pubkey', 'self')
  const recipeRes = await getRecord('kitchen.longtable.recipe', rkey)
  const binding = pubkeyRes.value
  const record = recipeRes.value
  pass('records fetched from the author\'s PDS', `"${record.name}" (${record.ingredients?.length ?? 0} ingredients)`)

  /* ---- Step 4: verify the repo export itself */
  const carRes = await fetch(
    `${pdsUrl}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(did)}`,
  )
  if (!carRes.ok) throw new Error(`getRepo → HTTP ${carRes.status}`)
  const carBytes = new Uint8Array(await carRes.arrayBuffer())
  let verifiedCids
  try {
    const verified = await verifyRepoCar(carBytes, did, signingKey)
    verifiedCids = new Set(verified.creates.map((c) => c.cid.toString()))
    pass('repo commit signature verifies against the DID document key')
  } catch (e) {
    fail('repo commit signature verifies against the DID document key', String(e).split('\n')[0])
    throw e
  }
  check('recipe record CID is inside the verified repo', () => {
    if (!verifiedCids.has(String(recipeRes.cid))) throw new Error('CID not in verified creates')
    return String(recipeRes.cid).slice(0, 16) + '…'
  })

  /* ---- Step 5: verify the device-key binding */
  const devicePubKey = sodium.from_base64(binding.devicePublicKey, sodium.base64_variants.ORIGINAL)
  check('binding deviceDid matches the binding public key', () => {
    const derived = formatDidKey('EdDSA', devicePubKey)
    if (derived !== binding.deviceDid) throw new Error(`${derived} != ${binding.deviceDid}`)
    return binding.deviceDid.slice(0, 20) + '…'
  })
  check('binding signature verifies (device key over the binding string)', () => {
    const msg = `longtable-pubkey:v1\n${did}\n${binding.deviceDid}\n${binding.devicePublicKey}`
    if (!verifyDetached(binding.signature, msg, devicePubKey)) throw new Error('bad signature')
  })

  /* ---- Step 6: verify the recipe's device signature */
  check('recipe names the bound device', () => {
    if (record.deviceDid !== binding.deviceDid) {
      throw new Error(`recipe deviceDid ${record.deviceDid} != binding ${binding.deviceDid}`)
    }
  })
  check('recipe device signature verifies (canonical hash + signed string)', () => {
    const msg = `longtable-recipe:v1\n${did}\n${record.longtableId}\n${canonicalHashHex(record)}`
    if (!verifyDetached(record.deviceSignature, msg, devicePubKey)) throw new Error('bad signature')
  })

  console.log('\n--- the recipe, as published ---')
  console.log(`${record.name} — by ${did}`)
  for (const ing of record.ingredients ?? []) console.log(`  · ${ing}`)
  ;(record.instructions ?? []).forEach((step, i) => console.log(`  ${i + 1}. ${step}`))

  console.log(failures === 0 ? '\nRESULT: ALL PASS — this recipe is genuinely the author\'s.' : `\nRESULT: ${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(`ERROR: ${String(e?.message ?? e).split('\n')[0]}`)
  process.exit(1)
})
