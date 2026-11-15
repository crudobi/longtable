/**
 * Discovery — Phase 3.
 *
 * Reads public recipes through the hub AppView (a filtered, indexed view
 * over the testnet firehose — clients never crawl PDSes themselves):
 *
 *   searchAppView(appViewUrl, {q, ingredients}) → result summaries
 *   fetchPublicRecipe(appViewUrl, did, rkey)    → the full record
 *   publicRecordToInput(record, fetchBlob)      → a local RecipeInput, so
 *                                                 "Save a copy" lands an
 *                                                 ordinary local recipe
 *
 * The AppView responses are normalized defensively (flat or nested record,
 * `results`/`recipes`/bare-array envelopes) so the client tolerates the
 * hub's exact envelope choices.
 *
 * Verification (review C2, 2026-11-15) — TRUST SPLIT, read before touching:
 *
 *   fetchPublicRecipe verifies the full record BEFORE it is returned (and
 *   therefore before anything displays it), and FAILS CLOSED: any missing
 *   or invalid deviceDid / deviceSignature / deviceKey, any canonical-hash
 *   mismatch, or any signature mismatch throws RecipeVerificationError
 *   and the recipe is never rendered as the author's. This check catches
 *   PDS forgery and AppView data tampering/corruption — the signature is
 *   recomputed from the record exactly as served.
 *
 *   What this check does NOT do: it does not verify the deviceDid↔
 *   deviceKey binding itself. That binding (the `kitchen.longtable.pubkey`
 *   /self record, signed over
 *   `longtable-pubkey:v1\n<accountDid>\n<deviceDid>\n<devicePublicKey>`)
 *   was verified by the AppView at ingest; the client takes the served
 *   deviceKey as the bound key for the served deviceDid, and additionally
 *   requires the two to be consistent with each other (the deviceDid must
 *   be the did:key of exactly the served deviceKey bytes). A hub that
 *   could substitute its own bound key is outside what the client can
 *   detect — that is the AppView-ingest half of C2, not this one.
 *
 *   Search summaries carry deviceDid / deviceSignature / deviceKey too,
 *   but no longtableId, so they CANNOT be verified from the summary alone
 *   — verification happens when the full record is opened. List items are
 *   therefore UNVERIFIED until opened: never badge them as verified.
 */
import sodium from 'libsodium-wrappers'
import type { RecipeInput } from '../types'
import { AtprotoError, type AtprotoBlob } from './atproto'
import { utf8ToU8 } from '../identity/codec'
import { cryptoReady, publicKeyFromDid } from '../identity/identity'
import {
  bytesToDataUrl,
  canonicalRecipeHash,
  recipeSignatureMessage,
  type RecipeRecord,
} from './publish'

export type { RecipeRecord }

export interface PublicSearchResult {
  did: string
  rkey: string
  uri?: string
  cid?: string
  title: string
  ingredients: string[]
  description?: string
  /**
   * The AppView serves these for every summary, but a summary carries no
   * longtableId, so they CANNOT be verified here — the record is verified
   * only when the full record is opened (see fetchPublicRecipe). Treat
   * list items as UNVERIFIED; never badge them as verified.
   */
  deviceDid?: string
  deviceSignature?: string
  deviceKey?: string
}

/**
 * A full public record plus its authoring account DID + rkey. `deviceKey`
 * is the bound device public key the AppView serves for the record
 * (standard base64, byte-identical to the pubkey binding record's
 * devicePublicKey field); `deviceDid`/`deviceSignature` come from the
 * record itself (see RecipeRecord). All three are required for
 * verification — fetchPublicRecipe refuses to return a record without
 * them (see verifyPublicRecipe).
 */
export type PublicRecipe = RecipeRecord & {
  did: string
  rkey: string
  uri?: string
  deviceKey?: string
}

export interface SearchQuery {
  q?: string
  ingredients?: string[] | string
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

async function getJson(
  fetchFn: FetchFn,
  url: string,
): Promise<{ status: number; data: unknown }> {
  const res = await fetchFn(url)
  let data: unknown = null
  try {
    data = await res.json()
  } catch {
    /* empty / non-JSON body */
  }
  return { status: res.status, data }
}

function didFromUri(uri: unknown): string {
  if (typeof uri !== 'string') return ''
  // at://did:plc:xxx/collection/rkey
  const m = /^at:\/\/([^/]+)\//.exec(uri)
  return m ? m[1] : ''
}

function rkeyFromUri(uri: unknown): string {
  if (typeof uri !== 'string') return ''
  const parts = uri.split('/')
  return parts.length > 0 ? parts[parts.length - 1] : ''
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function normalizeResult(raw: unknown): PublicSearchResult | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  const rec = (typeof o.record === 'object' && o.record !== null
    ? (o.record as Record<string, unknown>)
    : {}) as Record<string, unknown>
  const did =
    (typeof o.did === 'string' && o.did) ||
    (typeof o.authorDid === 'string' && o.authorDid) ||
    (typeof o.author === 'string' && o.author) ||
    didFromUri(o.uri)
  const rkey =
    (typeof o.rkey === 'string' && o.rkey) || rkeyFromUri(o.uri) ||
    (typeof rec.longtableId === 'string' ? rec.longtableId : '')
  if (!did || !rkey) return null
  const title =
    (typeof o.title === 'string' && o.title) ||
    (typeof o.name === 'string' && o.name) ||
    (typeof rec.name === 'string' && rec.name) ||
    '(untitled)'
  const ingredients = asStringArray(o.ingredients ?? rec.ingredients)
  const description =
    (typeof o.description === 'string' && o.description) ||
    (typeof rec.description === 'string' && rec.description) ||
    undefined
  return {
    did,
    rkey,
    uri: typeof o.uri === 'string' ? o.uri : undefined,
    cid: typeof o.cid === 'string' ? o.cid : undefined,
    title,
    ingredients,
    description,
    // Carried through only — summaries are UNVERIFIED until opened (see
    // the PublicSearchResult comment). Never badge a list item verified.
    deviceDid:
      (typeof o.deviceDid === 'string' && o.deviceDid) ||
      (typeof rec.deviceDid === 'string' && rec.deviceDid) ||
      undefined,
    deviceSignature:
      (typeof o.deviceSignature === 'string' && o.deviceSignature) ||
      (typeof rec.deviceSignature === 'string' && rec.deviceSignature) ||
      undefined,
    deviceKey:
      (typeof o.deviceKey === 'string' && o.deviceKey) ||
      (typeof rec.deviceKey === 'string' && rec.deviceKey) ||
      undefined,
  }
}

/**
 * Search the AppView. `q` matches recipe names; `ingredients` (array or
 * comma-separated string) matches ingredient text.
 */
export async function searchAppView(
  appViewUrl: string,
  query: SearchQuery = {},
  fetchFn: FetchFn = (url, init) => fetch(url, init),
): Promise<PublicSearchResult[]> {
  const base = trimSlash(appViewUrl)
  const params = new URLSearchParams()
  if (query.q) params.set('q', query.q)
  const ings = Array.isArray(query.ingredients)
    ? query.ingredients
    : query.ingredients
      ? query.ingredients.split(',').map((s) => s.trim()).filter(Boolean)
      : []
  if (ings.length > 0) params.set('ingredients', ings.join(','))
  const qs = params.toString()
  const suffix = qs ? `?${qs}` : ''

  let { status, data } = await getJson(fetchFn, `${base}/search${suffix}`)
  if (status === 404) {
    ;({ status, data } = await getJson(fetchFn, `${base}/api/search${suffix}`))
  }
  if (status < 200 || status >= 300) {
    throw new AtprotoError(`AppView search failed (${status})`, status)
  }
  const list: unknown[] = Array.isArray(data)
    ? data
    : Array.isArray((data as { results?: unknown[] })?.results)
      ? (data as { results: unknown[] }).results
      : Array.isArray((data as { recipes?: unknown[] })?.recipes)
        ? (data as { recipes: unknown[] }).recipes
        : []
  return list
    .map(normalizeResult)
    .filter((r): r is PublicSearchResult => r !== null)
}

// ---------------------------------------------------------------------------
// Device-signature verification (review C2 — client half).
//
// The AppView half verifies the deviceDid↔deviceKey binding at ingest and
// serves the three fields per recipe. This half verifies the recipe itself
// at read time, using the SAME canonicalRecipeHash as publish.ts — never a
// second scheme. Timestamps, mime/size and $type are NOT in the hash, and
// the message format is unchanged (out of scope for C2).
// ---------------------------------------------------------------------------

/** Machine-readable reason a record failed verification. */
export type RecipeVerificationReason =
  | 'missing-deviceDid'
  | 'invalid-deviceDid'
  | 'missing-deviceSignature'
  | 'invalid-deviceSignature'
  | 'missing-deviceKey'
  | 'invalid-deviceKey'
  | 'deviceKey-mismatch'
  | 'missing-longtableId'
  | 'signature-invalid'

/**
 * Thrown (fail closed) when a served public record cannot be verified as
 * genuinely from its author. The message is written for the UI — it is
 * what the user sees in place of the recipe — and `reason` carries the
 * precise failure for tests/logs. The recipe is never rendered.
 */
export class RecipeVerificationError extends Error {
  reason: RecipeVerificationReason
  constructor(reason: RecipeVerificationReason) {
    super(
      `This recipe failed its device-signature check (${reason}) and was ` +
        `not shown as genuinely from its author.`,
    )
    this.name = 'RecipeVerificationError'
    this.reason = reason
  }
}

/**
 * Decode standard (padded) base64, strictly — the value must round-trip
 * through re-encoding and decode to exactly `expectedLength` bytes (same
 * rule as the AppView's decodeBase64Strict; the signer always emits
 * canonical padded base64). Returns the bytes, or null.
 */
function decodeBase64Strict(value: unknown, expectedLength: number): Uint8Array | null {
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

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/**
 * Verify a full served record against the author's device key, fail closed.
 *
 * Checks, in order: the record has a longtableId (the signature binds
 * it); deviceDid is present and a well-formed Ed25519 did:key; deviceKey
 * is present and strict standard base64 for exactly 32 bytes; the did:key
 * decodes to exactly the served deviceKey bytes (the two served fields
 * must agree with each other); deviceSignature is present and strict
 * standard base64 for exactly 64 bytes; the canonical hash of the record
 * AS SERVED recomputed with publish.ts's canonicalRecipeHash, signed over
 * `longtable-recipe:v1\n<accountDid>\n<longtableId>\n<hashHex>`, verifies
 * detached-Ed25519 against the served deviceKey.
 *
 * Any failure throws RecipeVerificationError — the caller must not display
 * the record. `accountDid` is the served author DID (`did`), never a DID
 * taken from the record body (records carry no account field).
 */
export async function verifyPublicRecipe(
  record: PublicRecipe,
  accountDid: string,
): Promise<void> {
  await cryptoReady()
  if (typeof record.longtableId !== 'string' || record.longtableId.length === 0) {
    throw new RecipeVerificationError('missing-longtableId')
  }
  if (typeof record.deviceDid !== 'string' || record.deviceDid.length === 0) {
    throw new RecipeVerificationError('missing-deviceDid')
  }
  let didKeyBytes: Uint8Array
  try {
    didKeyBytes = publicKeyFromDid(record.deviceDid)
  } catch {
    throw new RecipeVerificationError('invalid-deviceDid')
  }
  if (typeof record.deviceKey !== 'string' || record.deviceKey.length === 0) {
    throw new RecipeVerificationError('missing-deviceKey')
  }
  const keyBytes = decodeBase64Strict(record.deviceKey, 32)
  if (!keyBytes) throw new RecipeVerificationError('invalid-deviceKey')
  if (!sameBytes(didKeyBytes, keyBytes)) {
    throw new RecipeVerificationError('deviceKey-mismatch')
  }
  if (typeof record.deviceSignature !== 'string' || record.deviceSignature.length === 0) {
    throw new RecipeVerificationError('missing-deviceSignature')
  }
  const sigBytes = decodeBase64Strict(record.deviceSignature, 64)
  if (!sigBytes) throw new RecipeVerificationError('invalid-deviceSignature')
  const hashHex = await canonicalRecipeHash(record)
  const msg = utf8ToU8(recipeSignatureMessage(accountDid, record.longtableId, hashHex))
  let ok: boolean
  try {
    ok = sodium.crypto_sign_verify_detached(sigBytes, msg, keyBytes)
  } catch {
    ok = false
  }
  if (!ok) throw new RecipeVerificationError('signature-invalid')
}

/** Fetch one full public record from the AppView by author DID + rkey. */
export async function fetchPublicRecipe(
  appViewUrl: string,
  did: string,
  rkey: string,
  fetchFn: FetchFn = (url, init) => fetch(url, init),
): Promise<PublicRecipe> {
  const base = trimSlash(appViewUrl)
  const attempts = [
    `${base}/recipe/${encodeURIComponent(did)}/${encodeURIComponent(rkey)}`,
    `${base}/recipe?${new URLSearchParams({ did, rkey }).toString()}`,
    `${base}/recipes/${encodeURIComponent(did)}/${encodeURIComponent(rkey)}`,
  ]
  let lastStatus = 0
  for (const url of attempts) {
    const { status, data } = await getJson(fetchFn, url)
    lastStatus = status
    if (status === 404) continue
    if (status < 200 || status >= 300) {
      throw new AtprotoError(`AppView recipe fetch failed (${status})`, status)
    }
    const o = (typeof data === 'object' && data !== null ? data : {}) as Record<
      string,
      unknown
    >
    const recRaw =
      (typeof o.record === 'object' && o.record !== null ? o.record : null) ??
      (typeof o.value === 'object' && o.value !== null ? o.value : null) ??
      (typeof o.recipe === 'object' && o.recipe !== null ? o.recipe : null) ??
      o
    const rec = recRaw as RecipeRecord
    // The AppView indexes optional fields as SQL NULLs — normalize to absent.
    const clean = { ...rec } as Record<string, unknown>
    for (const k of Object.keys(clean)) {
      if (clean[k] === null) delete clean[k]
    }
    const full: PublicRecipe = {
      ...(clean as unknown as RecipeRecord),
      ingredients: asStringArray(rec.ingredients),
      instructions: asStringArray(rec.instructions),
      did:
        (typeof o.did === 'string' && o.did) ||
        (typeof o.authorDid === 'string' && o.authorDid) ||
        did,
      rkey: (typeof o.rkey === 'string' && o.rkey) || rkey,
      uri: typeof o.uri === 'string' ? o.uri : undefined,
      // deviceKey is served alongside the record, not inside it (the
      // AppView's bound key, not a record field) — take it from the top
      // level, falling back to a nested record that carries it.
      deviceKey:
        (typeof o.deviceKey === 'string' && o.deviceKey) ||
        (typeof (recRaw as Record<string, unknown>).deviceKey === 'string' &&
          ((recRaw as Record<string, unknown>).deviceKey as string)) ||
        undefined,
    }
    // Fail closed: verify BEFORE returning — a record that does not verify
    // is never displayed as the author's, and never reaches "Save a copy".
    await verifyPublicRecipe(full, full.did)
    return full
  }
  throw new AtprotoError(`public recipe not found (${lastStatus})`, lastStatus || 404)
}

/**
 * Convert a public record into a local RecipeInput for "Save a copy".
 * `fetchBlobDataUrl(cid)` resolves one image blob to a data URL (the
 * caller wires it to the author's PDS via com.atproto.sync.getBlob);
 * blobs that fail to load are skipped, never fatal.
 */
export async function publicRecordToInput(
  record: PublicRecipe | RecipeRecord,
  fetchBlobDataUrl?: (cid: string, blob: AtprotoBlob) => Promise<string>,
): Promise<RecipeInput> {
  const photos: string[] = []
  if (fetchBlobDataUrl) {
    for (const blob of record.images ?? []) {
      try {
        photos.push(await fetchBlobDataUrl(blob.ref.$link, blob))
      } catch {
        /* skip an unloadable photo; the text recipe still copies */
      }
    }
  }
  return {
    title: record.name,
    ingredients: [...(record.ingredients ?? [])],
    steps: [...(record.instructions ?? [])],
    photos,
    prepMinutes: record.prepTimeMinutes,
    cookMinutes: record.cookTimeMinutes,
  }
}

/** Build a data URL for one blob fetched as raw bytes. */
export function blobBytesToDataUrl(bytes: Uint8Array, blob: AtprotoBlob): string {
  return bytesToDataUrl(bytes, blob.mimeType || 'image/jpeg')
}
