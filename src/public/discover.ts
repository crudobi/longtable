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
 * Verification (review C2, 2026-11-15; binding channel S3/H-N4,
 * 2026-11-21) — TRUST SPLIT, read before touching:
 *
 *   fetchPublicRecipe verifies the full record BEFORE it is returned (and
 *   therefore before anything displays it), and FAILS CLOSED: any missing
 *   or invalid deviceDid / deviceSignature / deviceKey, any canonical-hash
 *   mismatch, or any signature mismatch throws RecipeVerificationError
 *   and the recipe is never rendered as the author's. This check catches
 *   PDS forgery and AppView data tampering/corruption — the signature is
 *   recomputed from the record exactly as served.
 *
 *   The binding itself is verified too, through a channel the AppView
 *   is not part of (see src/public/binding.ts): the client fetches the
 *   author's `kitchen.longtable.pubkey` record for the recipe's deviceDid
 *   DIRECTLY from the author's PDS and verifies the binding signature
 *   itself, then verifies the recipe against that PDS-bound key — the
 *   served deviceKey must equal the bound key. A hub that substitutes
 *   its own key and re-signs is now detected: its deviceDid has no
 *   binding in the author's repo (`binding-not-found`), and serving
 *   the genuine deviceDid with a different key fails
 *   (`deviceKey-mismatch`).
 *
 *   Residual trust (stated in binding.ts, not hidden): the author's PDS
 *   is still trusted to serve the binding actually in the author's
 *   repo — a compromised PDS could insert a forged binding the way it
 *   could forge any record — and first sight of a device is
 *   trust-on-first-use (the client pins devices per author and the
 *   detail view shows the deviceDid plus known/new status, so a
 *   substitution after first sight is visible).
 *
 *   Search summaries carry deviceDid / deviceSignature / deviceKey and
 *   longtableId, but they still CANNOT be verified from the summary alone
 *   — the canonical hash needs description, instructions, prep/cook
 *   minutes, yield and images, which the summary does not carry, so
 *   verifying would mean fetching every full record behind a search.
 *   List items are therefore UNVERIFIED until opened and the UI says so
 *   explicitly ("Unverified — open to verify"); verification happens
 *   when the full record is opened. Never badge a list item as verified.
 */
import sodium from 'libsodium-wrappers'
import type { RecipeInput } from '../types'
import { AtprotoClient, AtprotoError, type AtprotoBlob } from './atproto'
import { utf8ToU8 } from '../identity/codec'
import { cryptoReady, publicKeyFromDid, type KeyValueStore } from '../identity/identity'
import {
  BindingVerificationError,
  defaultPinStore,
  devicePinState,
  fetchAuthorBinding,
  recordDevicePin,
  type BindingReason,
} from './binding'
import {
  bytesToDataUrl,
  canonicalRecipeHash,
  recipeSignatureMessage,
  type RecipeRecord,
} from './publish'
import { blobMatchesCid } from './blobCid'
import { MAX_PHOTO_BYTES } from '../importers/photoImport'
import { resolveAuthorPdsUrl } from './binding'

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
   * Carried through from the AppView summary (S10) so the open path
   * and any future summary-level check have the record's identity.
   * It does NOT make the summary verifiable on its own — the canonical
   * hash needs the full record (see the header comment).
   */
  longtableId?: string
  /**
   * The AppView serves these for every summary, but a summary cannot
   * be verified from its own fields — the record is verified only
   * when the full record is opened (see fetchPublicRecipe). Treat
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
  /**
   * How the device binding was verified (S3/H-N4): 'pds' means the
   * client fetched the binding record from the author's PDS and
   * verified its signature itself. Absent only for records that
   * predate this check.
   */
  bindingVerifiedVia?: 'pds'
  /**
   * Trust-on-first-use pin state at open time: true when this author+
   * device was already pinned from an earlier sighting, false on
   * first sight (the detail view says so — a new device for a known
   * author is worth a glance, not a block).
   */
  deviceSeenBefore?: boolean
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
    // Carried through (S10) — the summary's longtableId, for the open
    // path. It does not make the summary itself verifiable.
    longtableId:
      (typeof o.longtableId === 'string' && o.longtableId) ||
      (typeof rec.longtableId === 'string' && rec.longtableId) ||
      undefined,
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
  | BindingReason

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
 * When `trustedDeviceKey` is given (the key the author's PDS binds to
 * this device, fetched + verified by fetchAuthorBinding — S3/H-N4),
 * the served deviceKey must ALSO equal that bound key, and the recipe
 * signature is verified against the bound key: a hub that served its
 * own key for the genuine deviceDid fails `deviceKey-mismatch`, and a
 * hub that re-signed under its own deviceDid never gets this far (its
 * device has no PDS binding). Without it, the served key is trusted
 * as the bound key — the pre-H-N4 behavior, kept for direct callers
 * and unit tests of the recipe check alone.
 *
 * Any failure throws RecipeVerificationError — the caller must not display
 * the record. `accountDid` is the served author DID (`did`), never a DID
 * taken from the record body (records carry no account field).
 */
export async function verifyPublicRecipe(
  record: PublicRecipe,
  accountDid: string,
  trustedDeviceKey?: string,
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
  let keyBytes = decodeBase64Strict(record.deviceKey, 32)
  if (!keyBytes) throw new RecipeVerificationError('invalid-deviceKey')
  if (!sameBytes(didKeyBytes, keyBytes)) {
    throw new RecipeVerificationError('deviceKey-mismatch')
  }
  if (trustedDeviceKey !== undefined) {
    // S3/H-N4: the key the author's PDS binds to this device is the
    // authority — the hub-served key must be exactly that key, or the
    // hub substituted its own.
    const trustedBytes = decodeBase64Strict(trustedDeviceKey, 32)
    if (!trustedBytes) throw new RecipeVerificationError('invalid-deviceKey')
    if (!sameBytes(trustedBytes, keyBytes)) {
      throw new RecipeVerificationError('deviceKey-mismatch')
    }
    keyBytes = trustedBytes
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

/** Options for fetchPublicRecipe's binding check (S3/H-N4). */
export interface FetchPublicRecipeOptions {
  /** PLC directory base URL (default https://plc.directory). */
  plcUrl?: string
  /** First PDS to try for the binding — the viewer's own PDS URL
   * (testnet / single-PDS deployments). Falls back to PLC resolution. */
  authorPdsUrl?: string
  /** Trust-on-first-use pin store (default: localStorage-backed). */
  pinStore?: KeyValueStore
}

/** Fetch one full public record from the AppView by author DID + rkey. */
export async function fetchPublicRecipe(
  appViewUrl: string,
  did: string,
  rkey: string,
  fetchFn: FetchFn = (url, init) => fetch(url, init),
  options: FetchPublicRecipeOptions = {},
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
    // S3/H-N4: the binding is fetched from the author's PDS (never the
    // AppView) and verified here; the recipe is checked against the
    // PDS-bound key, not the hub-served one.
    if (typeof full.deviceDid !== 'string' || full.deviceDid.length === 0) {
      throw new RecipeVerificationError('missing-deviceDid')
    }
    let binding
    try {
      binding = await fetchAuthorBinding(full.did, full.deviceDid, fetchFn, {
        plcUrl: options.plcUrl,
        authorPdsUrl: options.authorPdsUrl,
      })
    } catch (e) {
      if (e instanceof BindingVerificationError) {
        throw new RecipeVerificationError(e.reason)
      }
      throw e
    }
    await verifyPublicRecipe(full, full.did, binding.devicePublicKey)
    const pinStore = options.pinStore ?? defaultPinStore()
    const seenBefore =
      devicePinState(pinStore, full.did, full.deviceDid) === 'known'
    recordDevicePin(pinStore, full.did, full.deviceDid)
    return { ...full, bindingVerifiedVia: 'pds', deviceSeenBefore: seenBefore }
  }
  throw new AtprotoError(`public recipe not found (${lastStatus})`, lastStatus || 404)
}

/**
 * Convert a public record into a local RecipeInput for "Save a copy".
 * `fetchBlobDataUrl(cid)` resolves one image blob to a data URL (the
 * caller wires it to the author's PDS via com.atproto.sync.getBlob);
 * blobs that fail to load are skipped, never fatal. `onPhotoSkipped`
 * is called for each skipped blob with the reason, so the caller can
 * tell the user a photo was left out instead of silently dropping it.
 */
export async function publicRecordToInput(
  record: PublicRecipe | RecipeRecord,
  fetchBlobDataUrl?: (cid: string, blob: AtprotoBlob) => Promise<string>,
  onPhotoSkipped?: (cid: string, reason: string) => void,
): Promise<RecipeInput> {
  const photos: string[] = []
  if (fetchBlobDataUrl) {
    for (const blob of record.images ?? []) {
      try {
        photos.push(await fetchBlobDataUrl(blob.ref.$link, blob))
      } catch (e) {
        // Skip an unloadable photo; the text recipe still copies — but
        // report it so the copy is not silently photo-less.
        onPhotoSkipped?.(
          blob.ref.$link,
          e instanceof Error ? e.message : String(e),
        )
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
    ...(record.description ? { description: record.description } : {}),
    ...(record.recipeYield ? { recipeYield: record.recipeYield } : {}),
    ...(record.tags && record.tags.length > 0 ? { tags: [...record.tags] } : {}),
    // Save-a-copy authorship: the copy keeps the author's account DID,
    // so it stays attributable instead of looking home-grown. A bare
    // RecipeRecord carries no DID (e.g. a local record being re-shaped),
    // so it keeps no author. The copy is private on this device —
    // visibility is deliberately NOT carried over.
    ...('did' in record && typeof record.did === 'string' && record.did
      ? { author: record.did }
      : {}),
  }
}

/**
 * The timestamps a save-a-copy preserves (production gap: the copy
 * used to be stamped "now", losing the original's history). Returns
 * the record's createdAt/updatedAt when both are well-formed ISO
 * strings, else undefined (the store then stamps "now").
 *
 * Timestamps are NOT covered by the recipe signature (Int L5), so a
 * tampered or malformed pair must never break the save — fall back
 * instead of failing or storing junk.
 */
export function publicRecordTimestamps(
  record: PublicRecipe | RecipeRecord,
): { createdAt: string; updatedAt: string } | undefined {
  const { createdAt, updatedAt } = record
  if (
    typeof createdAt === 'string' &&
    createdAt &&
    typeof updatedAt === 'string' &&
    updatedAt &&
    !Number.isNaN(Date.parse(createdAt)) &&
    !Number.isNaN(Date.parse(updatedAt))
  ) {
    return { createdAt, updatedAt }
  }
  return undefined
}

/** Options for fetchAuthorPhotoBytes. */
export interface FetchAuthorPhotoOptions {
  /** First PDS to try — the viewer's own PDS URL (testnet / single-PDS
   * deployments). Falls back to the author's PDS resolved via PLC. */
  authorPdsUrl?: string
  /** PLC directory base URL (default https://plc.directory). */
  plcUrl?: string
}

/**
 * Fetch one photo blob from the AUTHOR's PDS and verify it (M-N2).
 *
 * The old save-a-copy path fetched from the VIEWER's PDS, which 404s
 * for any author on another PDS — and stored whatever bytes came back
 * without checking them against the CID. This fetches from the author's
 * PDS (the caller's hint first, then — only when the hint misses — the
 * PDS resolved from the author's DID document via PLC, exactly like
 * the binding fetch in binding.ts),
 * caps the bytes at MAX_PHOTO_BYTES, and hash-checks them against the
 * CID before returning them. A CID mismatch fails closed immediately
 * with no fallthrough — a PDS serving wrong bytes for a CID is positive
 * evidence of a bad PDS, not a wrong address (same rule as a tampered
 * binding). A 404 on one candidate falls through to the next.
 */
export async function fetchAuthorPhotoBytes(
  authorDid: string,
  cid: string,
  fetchFn: FetchFn = (url, init) => fetch(url, init),
  options: FetchAuthorPhotoOptions = {},
): Promise<Uint8Array> {
  // One candidate attempt: fetch the blob, verify size + CID. Returns
  // the bytes on success, null when the blob is not reachable on this
  // PDS (fall through to the next candidate). A CID mismatch or an
  // over-cap blob throws immediately with no fallthrough — a PDS
  // serving wrong bytes for a CID is positive evidence of a bad PDS,
  // not a wrong address (same rule as a tampered binding).
  let lastError: Error | null = null
  const tryCandidate = async (pdsUrl: string): Promise<Uint8Array | null> => {
    const client = new AtprotoClient(pdsUrl, { fetchFn })
    let buf: ArrayBuffer
    try {
      buf = await client.getBlob(authorDid, cid)
    } catch (e) {
      // A 404 (RecordNotFound / BlobNotFound) means "not on this PDS" —
      // try the next candidate. Anything else (network, 5xx) is also
      // retried on the next candidate; the last error is reported if
      // every candidate fails.
      lastError = e instanceof Error ? e : new Error(String(e))
      return null
    }
    const bytes = new Uint8Array(buf)
    if (bytes.byteLength > MAX_PHOTO_BYTES) {
      throw new Error(
        `Photo ${cid} is larger than the ${MAX_PHOTO_BYTES / (1024 * 1024)} MB photo limit and was left out.`,
      )
    }
    if (!(await blobMatchesCid(cid, bytes))) {
      throw new Error(
        `Photo ${cid} failed its content check — the photo server returned bytes that do not match the photo's address. The photo was left out.`,
      )
    }
    return bytes
  }
  // The caller's hint first; the author's PDS via PLC is resolved
  // LAZILY, only when the hint misses — resolving it eagerly costs a
  // PLC round trip on every save-a-copy even on single-PDS deployments
  // (the Wave 3 bindings fix learned the same lesson).
  const hint = options.authorPdsUrl ? trimSlash(options.authorPdsUrl) : undefined
  if (hint) {
    const bytes = await tryCandidate(hint)
    if (bytes) return bytes
  }
  const resolved = await resolveAuthorPdsUrl(authorDid, fetchFn, options.plcUrl)
  if (resolved && resolved !== hint) {
    const bytes = await tryCandidate(resolved)
    if (bytes) return bytes
  }
  if (!hint && !resolved) {
    throw new Error(`Could not find the author's photo server for ${authorDid}.`)
  }
  throw (
    lastError ??
    new Error(`Photo ${cid} could not be fetched from the author's photo server.`)
  )
}

/** Build a data URL for one blob fetched as raw bytes. */
export function blobBytesToDataUrl(bytes: Uint8Array, blob: AtprotoBlob): string {
  return bytesToDataUrl(bytes, blob.mimeType || 'image/jpeg')
}
