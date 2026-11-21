/**
 * Author binding fetch + verification (review S3 / H-N4).
 *
 * The problem: `verifyPublicRecipe` (discover.ts) proves the served
 * deviceDid / deviceKey / signature are self-consistent, but the binding
 * of that device to the account was only as trustworthy as the AppView
 * that served it. A malicious or compromised AppView could take a
 * genuine record, alter its content, re-sign it with its own device
 * key, and serve a fully self-consistent forgery the client verified
 * and displayed as the author's. The client had no independent trust
 * anchor for the author's deviceDid.
 *
 * The fix — fetch the binding through a verifiable channel and verify
 * it client-side:
 *
 *   1. The client resolves the AUTHOR's PDS (the viewer's own PDS URL
 *      as a first hint — the same PDS the save-a-copy path already
 *      uses — falling back to the author's DID document via the PLC
 *      directory, which names the AtprotoPersonalDataServer endpoint)
 *      and fetches the binding record for the recipe's deviceDid
 *      DIRECTLY from that PDS with `com.atproto.repo.getRecord`,
 *      at the device's per-device rkey (H-N1). The AppView is not in
 *      this path at all: it cannot substitute a key, because the
 *      client never asks it for one.
 *   2. The client verifies the binding signature itself
 *      (`verifyPubkeyBindingRecord` — the client port of the AppView's
 *      `verifyPubkeyBinding`): the device key must match its did:key,
 *      and the binding signature must verify over
 *      `longtable-pubkey:v1\n<accountDid>\n<deviceDid>\n<devicePublicKey>`.
 *   3. The recipe is then verified against the PDS-bound key, not the
 *      hub-served key (discover.ts requires the served deviceKey to
 *      equal the bound key).
 *
 * Why this catches a hub substitution: a hub that mints its own keypair
 * and re-signs a record must serve the recipe under its own deviceDid
 * (the signature only verifies under the key that made it). That
 * deviceDid has no binding record in the author's repo, so the PDS
 * fetch 404s and the client rejects the recipe (`binding-not-found`).
 * If the hub instead serves the genuine deviceDid with its own key,
 * the served key differs from the PDS-bound key and the client rejects
 * it (`deviceKey-mismatch`). A tampered binding served by the PDS
 * fails its own signature check (`binding-signature-invalid`).
 *
 * What this does NOT do (residual trust, stated plainly):
 *
 * - The author's PDS is still trusted to serve the binding record
 *   that is actually in the author's repo. The PDS holds the repo
 *   key, so a compromised PDS could insert a forged binding for a
 *   hub-minted key and sign the commit for it — exactly the way it
 *   could already forge any record. What the PDS fetch removes is
 *   the APPVIEW as a forgery point: the forgery now requires the
 *   author's own host, not any aggregator the viewer happens to use.
 *   A full repo-signature check client-side (fetching the CAR and
 *   running verifyRepoCar) would not close this residual either — the
 *   repo signature is made with the same PDS-held key — so it is
 *   deliberately not done here: it would add the @atproto/repo
 *   bundle weight to the app for no additional security in this
 *   channel. The offline verifier (scripts/verify-public) still does
 *   the full CAR check for auditors.
 * - First sight is trust-on-first-use. A deviceDid the viewer has
 *   never seen before cannot be distinguished from a forgery on
 *   first sight by any check in this file — the binding signature
 *   proves the device endorsed the account, not that the viewer has
 *   met the device. So the client pins devices per author
 *   (TOFU pin store, localStorage): the detail view shows the
 *   deviceDid and whether it is a known device or newly seen, so a
 *   substitution AFTER first sight is visible to the user. Pins are
 *   advisory, not a hard gate: a hard gate would reject every
 *   legitimate new device (the H-N1 multi-device case) until the
 *   user approved it, with no approval UI in scope — and TOFU cannot
 *   tell a new legitimate device from a first-sight forgery anyway.
 *   The hard gate is the PDS binding fetch; the pin is the
 *   detectability layer the review asked for.
 *
 * All failures are fail-closed: any fetch problem, missing binding,
 * or signature failure throws BindingVerificationError, and the
 * caller (discover.ts) turns it into a RecipeVerificationError — the
 * recipe is never displayed.
 */
import sodium from 'libsodium-wrappers'
import { PUBKEY_COLLECTION, type FetchFn } from './atproto'
import { cryptoReady, publicKeyFromDid, type KeyValueStore } from '../identity/identity'
import { utf8ToU8 } from '../identity/codec'
import { pubkeyBindingMessage, pubkeyRkeyForDeviceDid, type PubkeyRecord } from './publish'
import { isSafeEndpointUrl } from '../hubs/endpointUrls'

/** The public PLC directory (overridable per call for testnets). */
export const DEFAULT_PLC_URL = 'https://plc.directory'

/** Per-fetch timeout for the PLC + PDS binding fetches: a hung upstream
 * must fail this recipe's verification, never hang the open path. */
export const BINDING_FETCH_TIMEOUT_MS = 15_000

/** localStorage key for the trust-on-first-use device pins. */
export const DEVICE_PINS_KEY = 'longtable:pinned-devices:v1'

/** Machine-readable reason a binding fetch/verification failed. */
export type BindingReason =
  | 'missing-binding'
  | 'invalid-binding-key'
  | 'invalid-binding-deviceDid'
  | 'binding-key-mismatch'
  | 'invalid-binding-signature'
  | 'binding-signature-invalid'
  | 'binding-deviceDid-mismatch'
  | 'binding-not-found'
  | 'binding-unavailable'

/** Thrown (fail closed) when the author's binding cannot be verified. */
export class BindingVerificationError extends Error {
  reason: BindingReason
  constructor(reason: BindingReason) {
    super(`Author device binding could not be verified (${reason}).`)
    this.name = 'BindingVerificationError'
    this.reason = reason
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

/** kv for best-effort pin persistence (no-op when localStorage is absent). */
export function defaultPinStore(): KeyValueStore {
  try {
    return localStorage
  } catch {
    const map = new Map<string, string>()
    return {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
    }
  }
}

// ---------------------------------------------------------------------------
// Binding-record verification (client port of the AppView's
// verifyPubkeyBinding — same checks, same reasons, same message).
// ---------------------------------------------------------------------------

/**
 * Decode standard (padded) base64, strictly — the value must round-trip
 * through re-encoding and decode to exactly `expectedLength` bytes (the
 * signer always emits canonical padded base64). Returns the bytes, or null.
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

export interface VerifiedBinding {
  deviceDid: string
  devicePublicKey: string
  devicePublicKeyBytes: Uint8Array
  /** The binding record as fetched from the PDS. */
  record: PubkeyRecord
}

/**
 * Verify a `kitchen.longtable.pubkey` binding record for `accountDid`.
 * Pure (no I/O): checks the key field decodes to 32 bytes, the deviceDid
 * is an Ed25519 did:key for exactly those bytes, and the binding
 * signature (64 bytes) verifies against the device key over the binding
 * message. Returns the verified binding, or { ok: false, reason }.
 */
export async function verifyPubkeyBindingRecord(
  accountDid: string,
  binding: unknown,
): Promise<
  | { ok: true; deviceDid: string; devicePublicKey: string; devicePublicKeyBytes: Uint8Array }
  | { ok: false; reason: BindingReason }
> {
  await cryptoReady()
  if (!binding || typeof binding !== 'object') {
    return { ok: false, reason: 'missing-binding' }
  }
  const b = binding as Partial<PubkeyRecord>
  const keyBytes = decodeBase64Strict(b.devicePublicKey, 32)
  if (!keyBytes) return { ok: false, reason: 'invalid-binding-key' }
  let didKeyBytes: Uint8Array
  try {
    didKeyBytes = publicKeyFromDid(b.deviceDid as string)
  } catch {
    return { ok: false, reason: 'invalid-binding-deviceDid' }
  }
  if (!sameBytes(keyBytes, didKeyBytes)) {
    return { ok: false, reason: 'binding-key-mismatch' }
  }
  const sig = decodeBase64Strict(b.signature, 64)
  if (!sig) return { ok: false, reason: 'invalid-binding-signature' }
  let ok: boolean
  try {
    ok = sodium.crypto_sign_verify_detached(
      sig,
      utf8ToU8(pubkeyBindingMessage(accountDid, b.deviceDid as string, b.devicePublicKey as string)),
      keyBytes,
    )
  } catch {
    ok = false
  }
  if (!ok) return { ok: false, reason: 'binding-signature-invalid' }
  return {
    ok: true,
    deviceDid: b.deviceDid as string,
    devicePublicKey: b.devicePublicKey as string,
    devicePublicKeyBytes: keyBytes,
  }
}

// ---------------------------------------------------------------------------
// Author PDS resolution (DID document → AtprotoPersonalDataServer)
// ---------------------------------------------------------------------------

interface DidDocService {
  id?: string
  type?: string
  serviceEndpoint?: unknown
}

/**
 * Resolve the author's PDS URL from their DID document. `did:plc` DIDs
 * resolve via the PLC directory; `did:web` DIDs resolve via
 * `https://<host>/.well-known/did.json`. Returns the PDS endpoint, or
 * null when the DID cannot be resolved or names no PDS — null is not an
 * error here, it just means this channel is unavailable and the caller
 * falls through to its other candidates (or fails closed).
 */
export async function resolveAuthorPdsUrl(
  accountDid: string,
  fetchFn: FetchFn,
  plcUrl: string = DEFAULT_PLC_URL,
): Promise<string | null> {
  // Sec L14: a plaintext PLC directory to a non-local host is not
  // a usable channel (did:web resolution is always https).
  if (
    accountDid.startsWith('did:plc:') &&
    !isSafeEndpointUrl(plcUrl, 'http')
  ) {
    return null
  }
  let docUrl: string
  if (accountDid.startsWith('did:plc:')) {
    docUrl = `${trimSlash(plcUrl)}/${accountDid}`
  } else if (accountDid.startsWith('did:web:')) {
    const parts = accountDid.slice('did:web:'.length).split(':')
    if (parts.length === 0 || !parts[0]) return null
    const host = decodeURIComponent(parts[0])
    const path = parts.slice(1).map((p) => decodeURIComponent(p)).join('/')
    docUrl = path
      ? `https://${host}/${path}/.well-known/did.json`
      : `https://${host}/.well-known/did.json`
  } else {
    return null
  }
  let doc: unknown
  try {
    const res = await fetchFn(docUrl, { signal: AbortSignal.timeout(BINDING_FETCH_TIMEOUT_MS) })
    if (!res.ok) return null
    doc = await res.json()
  } catch {
    return null
  }
  if (typeof doc !== 'object' || doc === null) return null
  const d = doc as { id?: unknown; service?: unknown }
  if (d.id !== accountDid) return null
  const services = Array.isArray(d.service) ? (d.service as DidDocService[]) : []
  const pds = services.find(
    (s) =>
      (typeof s?.id === 'string' && s.id === '#atproto_pds') ||
      (typeof s?.type === 'string' && s.type === 'AtprotoPersonalDataServer'),
  )
  if (typeof pds?.serviceEndpoint !== 'string' || !pds.serviceEndpoint) return null
  return trimSlash(pds.serviceEndpoint)
}

// ---------------------------------------------------------------------------
// Binding fetch from the author's PDS
// ---------------------------------------------------------------------------

export interface FetchAuthorBindingOptions {
  /** PLC directory base URL (default https://plc.directory). */
  plcUrl?: string
  /** First PDS to try — the viewer's own PDS URL (testnet / single-PDS
   * deployments). When it 404s, the PLC-resolved PDS is tried next. */
  authorPdsUrl?: string
}

type BindingFetchOutcome =
  | { status: 'ok'; binding: VerifiedBinding }
  | { status: 'not-found' }
  | { status: 'unavailable' }

async function fetchBindingFromPds(
  pdsUrl: string,
  accountDid: string,
  deviceDid: string,
  fetchFn: FetchFn,
): Promise<BindingFetchOutcome> {
  // Sec L14: a plaintext PDS URL to a non-local host is not a
  // candidate at all — return unavailable so the caller falls
  // through to the PLC-resolved PDS (or fails closed), instead of
  // fetching from it. The binding fetch is unauthenticated, but the
  // rule is uniform: no plaintext to a remote host.
  if (!isSafeEndpointUrl(pdsUrl, 'http')) return { status: 'unavailable' }
  const rkey = await pubkeyRkeyForDeviceDid(deviceDid)
  const qs = new URLSearchParams({
    repo: accountDid,
    collection: PUBKEY_COLLECTION,
    rkey,
  })
  let res: Response
  try {
    res = await fetchFn(
      `${trimSlash(pdsUrl)}/xrpc/com.atproto.repo.getRecord?${qs}`,
      { signal: AbortSignal.timeout(BINDING_FETCH_TIMEOUT_MS) },
    )
  } catch {
    return { status: 'unavailable' }
  }
  if (!res.ok) {
    let errName = ''
    try {
      const body = (await res.json()) as { error?: unknown }
      if (typeof body?.error === 'string') errName = body.error
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 404 || errName === 'RecordNotFound') {
      return { status: 'not-found' }
    }
    return { status: 'unavailable' }
  }
  let data: unknown
  try {
    data = await res.json()
  } catch {
    return { status: 'unavailable' }
  }
  const value = (data as { value?: unknown })?.value
  const checked = await verifyPubkeyBindingRecord(accountDid, value)
  if (!checked.ok) {
    // A binding that FAILS its own signature is positive evidence of
    // tampering, not a wrong address — fail closed immediately, never
    // fall through to another PDS that might serve a "better" answer.
    throw new BindingVerificationError(checked.reason)
  }
  if (checked.deviceDid !== deviceDid) {
    // The PDS served a valid binding for a DIFFERENT device at this
    // device's rkey — the record does not bind the device asked for.
    throw new BindingVerificationError('binding-deviceDid-mismatch')
  }
  return {
    status: 'ok',
    binding: {
      deviceDid: checked.deviceDid,
      devicePublicKey: checked.devicePublicKey,
      devicePublicKeyBytes: checked.devicePublicKeyBytes,
      record: value as PubkeyRecord,
    },
  }
}

/**
 * Fetch + verify the binding for (`accountDid`, `deviceDid`) from the
 * author's PDS. Candidates, in order: the caller's `authorPdsUrl` hint
 * (when given — the fast path on testnet / single-PDS deployments, and
 * the only path when PLC cannot resolve the author), then the PDS
 * resolved from the author's DID document via PLC. PLC is resolved
 * LAZILY — only when the hint did not already yield the binding — so
 * a working hint costs no extra round trip. A 404 on one candidate
 * falls through to the next; a tampered binding fails closed
 * immediately. Throws BindingVerificationError when no candidate yields
 * a verified binding ('binding-not-found' when a reachable PDS said
 * the record is absent — the hub-substitution signal — else
 * 'binding-unavailable').
 */
export async function fetchAuthorBinding(
  accountDid: string,
  deviceDid: string,
  fetchFn: FetchFn,
  options: FetchAuthorBindingOptions = {},
): Promise<VerifiedBinding> {
  let sawNotFound = false
  if (options.authorPdsUrl) {
    const outcome = await fetchBindingFromPds(
      trimSlash(options.authorPdsUrl),
      accountDid,
      deviceDid,
      fetchFn,
    )
    if (outcome.status === 'ok') return outcome.binding
    if (outcome.status === 'not-found') sawNotFound = true
  }
  const resolved = await resolveAuthorPdsUrl(accountDid, fetchFn, options.plcUrl)
  if (
    resolved &&
    (!options.authorPdsUrl || trimSlash(options.authorPdsUrl) !== resolved)
  ) {
    const outcome = await fetchBindingFromPds(resolved, accountDid, deviceDid, fetchFn)
    if (outcome.status === 'ok') return outcome.binding
    if (outcome.status === 'not-found') sawNotFound = true
  }
  if (!options.authorPdsUrl && !resolved) {
    throw new BindingVerificationError('binding-unavailable')
  }
  throw new BindingVerificationError(sawNotFound ? 'binding-not-found' : 'binding-unavailable')
}

// ---------------------------------------------------------------------------
// Trust-on-first-use device pins (the trust anchor for a deviceDid)
// ---------------------------------------------------------------------------

/** Pins: accountDid → deviceDid → first-seen ISO timestamp. */
export type DevicePins = Record<string, Record<string, string>>

export function loadDevicePins(kv: KeyValueStore): DevicePins {
  try {
    const raw = kv.getItem(DEVICE_PINS_KEY)
    if (!raw) return {}
    const obj: unknown = JSON.parse(raw)
    if (typeof obj !== 'object' || obj === null) return {}
    const pins: DevicePins = {}
    for (const [did, devices] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof devices !== 'object' || devices === null) continue
      const per: Record<string, string> = {}
      for (const [deviceDid, at] of Object.entries(devices as Record<string, unknown>)) {
        if (typeof at === 'string') per[deviceDid] = at
      }
      pins[did] = per
    }
    return pins
  } catch {
    // A corrupt pin store is not a verification failure — start fresh.
    return {}
  }
}

/** 'known' when this author+device was pinned before, else 'new'. */
export function devicePinState(
  kv: KeyValueStore,
  accountDid: string,
  deviceDid: string,
): 'known' | 'new' {
  const pins = loadDevicePins(kv)
  return typeof pins[accountDid]?.[deviceDid] === 'string' ? 'known' : 'new'
}

/** Record the first sighting of an author+device (no-op when already pinned). */
export function recordDevicePin(
  kv: KeyValueStore,
  accountDid: string,
  deviceDid: string,
): void {
  const pins = loadDevicePins(kv)
  if (typeof pins[accountDid]?.[deviceDid] === 'string') return
  if (!pins[accountDid]) pins[accountDid] = {}
  pins[accountDid][deviceDid] = new Date().toISOString()
  try {
    kv.setItem(DEVICE_PINS_KEY, JSON.stringify(pins))
  } catch {
    /* pin persistence is best-effort — verification already passed */
  }
}
