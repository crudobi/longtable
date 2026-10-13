/**
 * verify.mjs — the anti-forge core.
 *
 * `createVerifiedRepoProvider` returns an async function
 *   getVerifiedRepoState(did) -> { did, commitCid, records: [{collection, rkey, cid, record}] }
 * that ONLY returns records from a repo state whose commit signature has
 * been verified against the signing key in the author's DID document.
 *
 * Verification path (real @atproto libraries, no hand-rolled MST/crypto):
 *   1. Fetch the DID document from the PLC directory: GET $PLC_URL/<did>.
 *      Extract the `#atproto` verification method's publicKeyMultibase and
 *      form the did:key (`getSigningDidKey` from @atproto/common does
 *      exactly this lookup; a manual extraction below is the fallback).
 *   2. Fetch the full repo CAR: GET $PDS_URL/xrpc/com.atproto.sync.getRepo?did=<did>.
 *   3. `verifyRepoCar(carBytes, did, signingKey)` from @atproto/repo:
 *      parses the CAR, loads the commit, checks commit.did === did, verifies
 *      the commit signature with @atproto/crypto's verifySignature against
 *      the DID-doc key, walks the MST diff against empty (all leaves must be
 *      present), and returns the verified creates (collection/rkey/CID).
 *   4. Extract record bodies from the SAME CAR by walking the verified
 *      commit's MST (`MST.load` + `reachableLeaves()` + `getAndParseRecord`,
 *      all from @atproto/repo) and require every walked record's CID to
 *      appear in the verified creates set — so a record body can never
 *      enter the index unless its exact CID was part of the
 *      signature-verified repo state.
 *
 * Any failure (bad signature, DID mismatch, missing key, unreachable PDS/PLC,
 * malformed CAR) throws; callers treat a throw as "index nothing, count a
 * rejection".
 *
 * Tests inject a fake provider with the same return shape (see ingest.mjs),
 * so this module is the single production verification path.
 */
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

/**
 * Extract the author's repo signing key as a did:key.
 *
 * Modern DID docs carry a multicodec-prefixed key in the #atproto
 * verification method (`getSigningDidKey` returns it directly). Some PLC
 * deployments — including this local testnet — still emit the legacy
 * `EcdsaSecp256k1VerificationKey2019` shape, whose publicKeyMultibase is
 * base58btc of the *raw* public key bytes (no multicodec prefix; e.g. a
 * 65-byte uncompressed secp256k1 point), which @atproto/crypto's
 * parseMultikey rejects as "Unsupported key type". For those, we re-wrap
 * the raw bytes into a standard did:key with `formatDidKey` (which applies
 * the multicodec prefix and point compression). This is key-*format*
 * normalization only: the result is validated with parseDidKey, and the
 * actual signature check still happens in verifyRepoCar — a wrong guess
 * fails verification and indexes nothing.
 */
export function extractSigningDidKey(didDoc) {
  try {
    const viaHelper = getSigningDidKey(didDoc)
    if (viaHelper) {
      parseDidKey(viaHelper)
      return viaHelper
    }
  } catch {
    // fall through to manual extraction / legacy normalization
  }
  const methods = Array.isArray(didDoc?.verificationMethod) ? didDoc.verificationMethod : []
  const vm =
    methods.find((m) => typeof m?.id === 'string' && m.id.endsWith('#atproto')) ?? methods[0]
  const mb = vm?.publicKeyMultibase
  if (!mb) return undefined

  const direct = `did:key:${mb}`
  try {
    parseDidKey(direct)
    return direct
  } catch {
    // not a multicodec multikey — try legacy raw-key normalization
  }

  let raw
  try {
    raw = multibaseToBytes(mb)
  } catch {
    return undefined
  }
  const type = String(vm?.type ?? '')
  const algs = []
  if (/secp256k1/i.test(type)) algs.push('ES256K')
  if (/secp256r1|p-?256/i.test(type)) algs.push('ES256')
  if (/ed25519/i.test(type)) algs.push('EdDSA')
  for (const a of ['ES256K', 'ES256', 'EdDSA']) if (!algs.includes(a)) algs.push(a)
  for (const alg of algs) {
    // Length gate: Ed25519 public keys are 32 raw bytes; EC keys are a
    // 33-byte compressed or 65-byte uncompressed point.
    if (alg === 'EdDSA' && raw.length !== 32) continue
    if (alg !== 'EdDSA' && raw.length !== 33 && raw.length !== 65) continue
    try {
      const candidate = formatDidKey(alg, raw)
      parseDidKey(candidate)
      return candidate
    } catch {
      // not this curve / not a valid point — try the next
    }
  }
  return undefined
}

export function createVerifiedRepoProvider({ pdsUrl, plcUrl, fetchImpl = fetch } = {}) {
  if (!pdsUrl) throw new Error('createVerifiedRepoProvider: pdsUrl is required')
  if (!plcUrl) throw new Error('createVerifiedRepoProvider: plcUrl is required')

  return async function getVerifiedRepoState(did) {
    // 1. DID document -> signing key
    const docRes = await fetchImpl(`${plcUrl}/${did}`)
    if (!docRes.ok) throw new Error(`PLC lookup for ${did} failed: HTTP ${docRes.status}`)
    const didDoc = await docRes.json()
    if (didDoc?.id !== did) throw new Error(`DID document id mismatch for ${did}`)
    const signingKey = extractSigningDidKey(didDoc)
    if (!signingKey) throw new Error(`No #atproto signing key in DID document for ${did}`)

    // 2. Full repo CAR from the PDS
    const carRes = await fetchImpl(
      `${pdsUrl}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(did)}`,
    )
    if (!carRes.ok) throw new Error(`getRepo for ${did} failed: HTTP ${carRes.status}`)
    const carBytes = new Uint8Array(await carRes.arrayBuffer())
    if (carBytes.length === 0) throw new Error(`getRepo for ${did} returned an empty CAR`)

    // 3. Cryptographic verification of the commit chain head against the key.
    //    Throws RepoVerificationError on a bad signature or DID mismatch.
    const verified = await verifyRepoCar(carBytes, did, signingKey)
    const verifiedCids = new Set(verified.creates.map((c) => c.cid.toString()))

    // 4. Record bodies from the same verified CAR, cross-checked by CID.
    //    (@atproto/repo 0.6 does not export ReadableRepo; walk the MST of the
    //    verified commit directly — the same traversal verifyRecords uses.)
    const { root, blocks } = await readCarWithRoot(carBytes)
    const blockstore = new MemoryBlockstore(blocks)
    const commit = await blockstore.readObj(root, def.commit)
    if (commit.did !== did) throw new Error(`Repo DID mismatch: ${commit.did} !== ${did}`)
    const mst = MST.load(blockstore, commit.data)
    const leaves = await mst.reachableLeaves()
    const records = []
    for (const leaf of leaves) {
      const cid = leaf.value.toString()
      if (!verifiedCids.has(cid)) {
        throw new Error(`Record at ${leaf.key} (${cid}) not in verified creates`)
      }
      const { collection, rkey } = parseDataKey(leaf.key)
      const { record } = await getAndParseRecord(blocks, leaf.value)
      records.push({ collection, rkey, cid, record })
    }
    if (records.length !== verifiedCids.size) {
      throw new Error(
        `Verified repo state mismatch for ${did}: ${records.length} records vs ${verifiedCids.size} verified creates`,
      )
    }
    return { did, commitCid: verified.commit.cid.toString(), records }
  }
}
