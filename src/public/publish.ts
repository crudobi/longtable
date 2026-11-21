/**
 * Public publishing — Phase 3.
 *
 * Turns a local recipe into a `kitchen.longtable.recipe` ATProto record on
 * the user's PDS, and back off again:
 *
 *   publishRecipe:  upload photos as blobs → build the record → sign it
 *                   with the device key → putRecord → remember the
 *                   publication in the local registry.
 *   unpublishRecipe: deleteRecord + drop the registry entry.
 *
 * Device signatures (a third-party verifier recomputes these EXACTLY):
 *   recipe hash  = BLAKE2b-256 (libsodium crypto_generichash, hex) over
 *                  JSON.stringify([name, description||"", ingredients,
 *                  instructions, prepTimeMinutes??null,
 *                  cookTimeMinutes??null, recipeYield||"", tags||[],
 *                  imageCids]) — imageCids are the blob $link strings.
 *   recipe msg   = "longtable-recipe:v1\n" + accountDid + "\n" +
 *                  longtableId + "\n" + hashHex        (UTF-8, detached)
 *   pubkey msg   = "longtable-pubkey:v1\n" + accountDid + "\n" +
 *                  deviceDid + "\n" + devicePublicKeyBase64
 */
import sodium from 'libsodium-wrappers'
import {
  cryptoReady,
  signDetached,
  type Identity,
  type KeyValueStore,
} from '../identity/identity'
import { base64ToU8, u8ToBase64, utf8ToU8 } from '../identity/codec'
import { secretKv } from '../secrets/secretStore'
import type { Recipe } from '../types'
import {
  PUBLICATIONS_KEY,
  PUBKEY_COLLECTION,
  RECIPE_COLLECTION,
  saveSession,
  type AtprotoBlob,
  type AtprotoSession,
  type FetchFn,
  type Publication,
  type PublicKv,
} from './atproto'
import { AtprotoClient } from './atproto'
import {
  getRecipeProvenance,
  receivedRecipeRefusal,
} from '../friends/provenance'

export { PUBLICATIONS_KEY, RECIPE_COLLECTION, PUBKEY_COLLECTION }

/** A local recipe plus its store id (the record's rkey + longtableId). */
export type PublishableRecipe = Recipe & { id: string }

/** The `kitchen.longtable.recipe` record shape (lexicon-shaped). */
export interface RecipeRecord {
  $type: 'kitchen.longtable.recipe'
  name: string
  description?: string
  ingredients: string[]
  instructions: string[]
  prepTimeMinutes?: number
  cookTimeMinutes?: number
  recipeYield?: string
  tags?: string[]
  images?: AtprotoBlob[]
  deviceDid?: string
  deviceSignature?: string
  createdAt: string
  updatedAt: string
  longtableId: string
}

/**
 * The `kitchen.longtable.pubkey` record shape. One record per device, at
 * the rkey `pubkeyRkeyForDeviceDid(deviceDid)` (H-N1): a second device
 * publishing must NOT overwrite the first device's binding, so each
 * device binds under its own rkey. The legacy single-slot rkey "self"
 * (pre-H-N1 clients) is still honored by the AppView as one device's
 * binding — see `verifyPubkeyBindings` in appview/device-signature.mjs —
 * but this client never writes it.
 */
export interface PubkeyRecord {
  $type: 'kitchen.longtable.pubkey'
  deviceDid: string
  devicePublicKey: string
  signature: string
  createdAt: string
}

// ---------------------------------------------------------------------------
// Data URLs
// ---------------------------------------------------------------------------

/** Split a data URL into its raw bytes + mime type. */
export function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mime: string } {
  const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(dataUrl)
  if (!m) throw new Error('not a data URL')
  const mime = m[1] || 'application/octet-stream'
  if (m[2]) {
    return { bytes: base64ToU8(m[3].replace(/\s/g, '')), mime }
  }
  return { bytes: utf8ToU8(decodeURIComponent(m[3])), mime }
}

/** Encode raw bytes as a data URL with the given mime type. */
export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${u8ToBase64(bytes)}`
}

// ---------------------------------------------------------------------------
// Record building + device signatures (pure / verifiable)
// ---------------------------------------------------------------------------

type RecipeExtras = Recipe & {
  description?: string
  recipeYield?: string
  tags?: string[]
}

/**
 * Map a local recipe to its ATProto record (unsigned). `images` may be
 * full blob objects (from uploadBlob) or bare CID strings; bare strings
 * become ref-only blob objects so the $link order is preserved either way.
 * Pure: no I/O, no signing (deviceDid/deviceSignature are attached by
 * publishRecipe after signRecipeRecord).
 */
export function buildRecipeRecord(
  recipe: PublishableRecipe,
  // The account DID is part of the fixed call shape (the record lives in
  // the account's repo; the signature payload binds it). The record body
  // itself carries no account field.
  _accountDid: string,
  images: Array<AtprotoBlob | string> = [],
): RecipeRecord {
  const r = recipe as RecipeExtras
  const blobs: AtprotoBlob[] = images.map((img) =>
    typeof img === 'string'
      ? { $type: 'blob', ref: { $link: img }, mimeType: 'image/*', size: 0 }
      : img,
  )
  const record: RecipeRecord = {
    $type: 'kitchen.longtable.recipe',
    name: recipe.title,
    ingredients: [...recipe.ingredients],
    instructions: [...recipe.steps],
    createdAt: recipe.createdAt,
    updatedAt: recipe.updatedAt,
    longtableId: recipe.id,
  }
  if (r.description) record.description = r.description
  if (recipe.prepMinutes !== undefined) record.prepTimeMinutes = recipe.prepMinutes
  if (recipe.cookMinutes !== undefined) record.cookTimeMinutes = recipe.cookMinutes
  if (r.recipeYield) record.recipeYield = r.recipeYield
  if (r.tags && r.tags.length > 0) record.tags = [...r.tags]
  if (blobs.length > 0) record.images = blobs
  return record
}

/** The image $link strings of a record, in order (canonical-hash input). */
export function recordImageCids(record: RecipeRecord): string[] {
  return (record.images ?? []).map((b) => b.ref.$link)
}

/**
 * Canonical recipe hash: BLAKE2b-256 hex over the JSON canonical array.
 * `imageCids` defaults to the record's own image $links.
 */
export async function canonicalRecipeHash(
  record: RecipeRecord,
  imageCids: string[] = recordImageCids(record),
): Promise<string> {
  await cryptoReady()
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
  return sodium.to_hex(sodium.crypto_generichash(32, utf8ToU8(canonical), null))
}

/** The exact UTF-8 payload signed for a recipe record. */
export function recipeSignatureMessage(
  accountDid: string,
  longtableId: string,
  hashHex: string,
): string {
  return `longtable-recipe:v1\n${accountDid}\n${longtableId}\n${hashHex}`
}

/** Sign a (signature-less) record; returns the base64 detached signature. */
export async function signRecipeRecord(
  identity: Identity,
  accountDid: string,
  record: RecipeRecord,
): Promise<string> {
  const hashHex = await canonicalRecipeHash(record)
  const msg = utf8ToU8(recipeSignatureMessage(accountDid, record.longtableId, hashHex))
  const sig = await signDetached(identity, msg)
  return u8ToBase64(sig)
}

/** The exact UTF-8 payload signed for the pubkey binding record. */
export function pubkeyBindingMessage(
  accountDid: string,
  deviceDid: string,
  devicePublicKeyBase64: string,
): string {
  return `longtable-pubkey:v1\n${accountDid}\n${deviceDid}\n${devicePublicKeyBase64}`
}

/**
 * The per-device rkey for a device's pubkey binding record (H-N1).
 *
 * `dev-` + the first 32 hex chars of the BLAKE2b-256 of the deviceDid
 * string. Deterministic from the deviceDid alone, so any party — the
 * publishing client, the AppView, a reader fetching the binding from
 * the PDS — can compute the address of a device's binding without an
 * index scan. The deviceDid itself is NOT used as the rkey: it contains
 * colons, which the ATProto rkey grammar allows in theory but PDS
 * implementations validate unevenly; `dev-<hex>` is valid under every
 * rkey rule (lowercase alphanumerics + hyphen) and fixed-length. The
 * binding record itself still carries the deviceDid, so the rkey is an
 * address, not the identity.
 *
 * Cross-implementation pin:
 * pubkeyRkeyForDeviceDid(
 *   'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK')
 * === 'dev-af0042b31ec6679cc02818a49bf60f70' (BLAKE2b-256 computed
 * independently; the AppView and client tests pin the same vector).
 */
export async function pubkeyRkeyForDeviceDid(deviceDid: string): Promise<string> {
  await cryptoReady()
  const hashHex = sodium.to_hex(
    sodium.crypto_generichash(32, utf8ToU8(deviceDid), null),
  )
  return `dev-${hashHex.slice(0, 32)}`
}

// ---------------------------------------------------------------------------
// Publications registry (localStorage)
// ---------------------------------------------------------------------------

export function loadPublications(
  kv: PublicKv = localStorage,
): Record<string, Publication> {
  try {
    const raw = kv.getItem(PUBLICATIONS_KEY)
    if (!raw) return {}
    const obj: unknown = JSON.parse(raw)
    return typeof obj === 'object' && obj !== null
      ? (obj as Record<string, Publication>)
      : {}
  } catch {
    return {}
  }
}

export function getPublication(
  recipeId: string,
  kv: PublicKv = localStorage,
): Publication | null {
  return loadPublications(kv)[recipeId] ?? null
}

function savePublication(pub: Publication, kv: PublicKv): void {
  const all = loadPublications(kv)
  all[pub.rkey] = pub
  kv.setItem(PUBLICATIONS_KEY, JSON.stringify(all))
}

function dropPublication(recipeId: string, kv: PublicKv): void {
  const all = loadPublications(kv)
  if (recipeId in all) {
    delete all[recipeId]
    kv.setItem(PUBLICATIONS_KEY, JSON.stringify(all))
  }
}

// ---------------------------------------------------------------------------
// Pubkey binding
// ---------------------------------------------------------------------------

/**
 * Ensure the account's `kitchen.longtable.pubkey` record for THIS device
 * binds this device key, at its per-device rkey (H-N1). Writes the record
 * only when it is missing or bound to a different key. Returns true when
 * a record was written.
 *
 * A second device publishing NEVER touches another device's binding:
 * each device writes only its own per-device rkey, and the legacy `self`
 * record is never read or overwritten here. The AppView verifies each
 * recipe against its own device's binding, so two devices flip-flopping
 * no longer un-publish each other's recipes.
 */
export async function ensurePubkeyBinding(
  client: AtprotoClient,
  session: AtprotoSession,
  identity: Identity,
  kv: KeyValueStore = localStorageSafe(),
): Promise<boolean> {
  const rkey = await pubkeyRkeyForDeviceDid(identity.did)
  const existing = await client.getRecord(session.did, PUBKEY_COLLECTION, rkey)
  const devicePublicKey = u8ToBase64(identity.publicKey)
  if (
    existing &&
    existing.value.deviceDid === identity.did &&
    existing.value.devicePublicKey === devicePublicKey
  ) {
    return false
  }
  const msg = utf8ToU8(pubkeyBindingMessage(session.did, identity.did, devicePublicKey))
  const signature = u8ToBase64(await signDetached(identity, msg))
  const record: PubkeyRecord = {
    $type: 'kitchen.longtable.pubkey',
    deviceDid: identity.did,
    devicePublicKey,
    signature,
    createdAt: new Date().toISOString(),
  }
  await client.putRecord(session, {
    repo: session.did,
    collection: PUBKEY_COLLECTION,
    rkey,
    record: { ...record } as Record<string, unknown>,
  })
  saveSession(session, kv as PublicKv)
  return true
}

/**
 * kv for session persistence: the secure store (Keystore on Android,
 * localStorage on web). It never throws — when localStorage is absent
 * (node) it falls back to a process-local map — and it routes the
 * publications registry (non-secret) to localStorage while the session
 * (secret) goes to the Keystore.
 */
function localStorageSafe(): PublicKv {
  return secretKv
}

// ---------------------------------------------------------------------------
// Publish / unpublish
// ---------------------------------------------------------------------------

/**
 * Publish (or republish) a recipe: ensure the pubkey binding, upload its
 * photos as blobs, build + device-sign the record, putRecord it, and save
 * the publication in the local registry. Returns the record URI.
 *
 * H4: a recipe received from a friend is never published as this
 * device's own — the refusal happens here as well as in the
 * visibility flow, so no caller can publish a received copy by
 * going around the flow.
 */
export async function publishRecipe(
  client: AtprotoClient,
  session: AtprotoSession,
  identity: Identity,
  recipe: PublishableRecipe,
  kv: KeyValueStore = localStorageSafe(),
): Promise<string> {
  const provenance = getRecipeProvenance(recipe.id, kv)
  if (provenance) throw new Error(receivedRecipeRefusal(provenance))
  await ensurePubkeyBinding(client, session, identity, kv)

  const blobs: AtprotoBlob[] = []
  for (const photo of recipe.photos) {
    const { bytes, mime } = dataUrlToBytes(photo)
    blobs.push(await client.uploadBlob(session, bytes, mime))
  }

  const unsigned = buildRecipeRecord(recipe, session.did, blobs)
  const deviceSignature = await signRecipeRecord(identity, session.did, unsigned)
  const record: RecipeRecord = {
    ...unsigned,
    deviceDid: identity.did,
    deviceSignature,
  }
  const { uri, cid } = await client.putRecord(session, {
    repo: session.did,
    collection: RECIPE_COLLECTION,
    rkey: recipe.id,
    record: { ...record } as Record<string, unknown>,
  })
  const finalUri = uri || `at://${session.did}/${RECIPE_COLLECTION}/${recipe.id}`
  savePublication(
    {
      did: session.did,
      uri: finalUri,
      rkey: recipe.id,
      cid: cid ?? '',
      pdsUrl: session.pdsUrl || client.pdsUrl,
      updatedAt: new Date().toISOString(),
    },
    kv as PublicKv,
  )
  saveSession(session, kv as PublicKv)
  return finalUri
}

/**
 * Remove a recipe's public record from the PDS and drop its registry
 * entry. A record that is already gone counts as unpublished.
 *
 * M-N3: the delete goes to the PDS the record was actually published
 * to — the stored `publication.pdsUrl` — first, not to the session's
 * current PDS. After an account/PDS move, deleting on the new PDS
 * 404s while the record stays live on the old one; the old code then
 * dropped the registry entry and lost all trace of it. The stored PDS
 * is attempted first; when it differs from the session PDS the session
 * PDS is attempted too (the record may have been re-created there).
 * A 404 on a PDS only counts as "gone" for that PDS; the registry
 * entry is dropped only once every attempted PDS answered success or
 * 404. Anything else throws and the registry entry is kept, so the
 * unpublish can be retried instead of silently succeeding.
 * Returns the PDS URLs attempted and any cross-PDS warnings.
 */
export async function unpublishRecipe(
  client: AtprotoClient,
  session: AtprotoSession,
  recipeId: string,
  kv: KeyValueStore = localStorageSafe(),
  opts: { fetchFn?: FetchFn } = {},
): Promise<{ pdsUrlsAttempted: string[]; warnings: string[] }> {
  const pub = getPublication(recipeId, kv as PublicKv)
  const storedPds = pub?.pdsUrl
  const targets: string[] = []
  if (storedPds) targets.push(storedPds)
  if (!targets.includes(session.pdsUrl)) targets.push(session.pdsUrl)
  const warnings: string[] = []
  if (storedPds && storedPds !== session.pdsUrl) {
    warnings.push(
      'This recipe was published to a different publishing server than the one signed in now — removing it from both.',
    )
  }
  let anyDeleted = false
  let allResolved = true
  for (const pdsUrl of targets) {
    // The passed client already speaks the session PDS (and carries
    // the caller's fetch, e.g. a test fake); a different stored PDS
    // gets a fresh client for that host.
    const targetClient =
      pdsUrl === client.pdsUrl
        ? client
        : new AtprotoClient(pdsUrl, { fetchFn: opts.fetchFn })
    try {
      await targetClient.deleteRecord(session, {
        repo: session.did,
        collection: RECIPE_COLLECTION,
        rkey: recipeId,
      })
      anyDeleted = true
    } catch (e) {
      const status = (e as { status?: number }).status
      const name = (e as { error?: string }).error
      if (status === 404 || name === 'RecordNotFound') {
        if (pdsUrl === storedPds) {
          warnings.push(
            'The record was already gone from the publishing server it was published to.',
          )
        }
        continue
      }
      // A real failure on one PDS must not drop the registry entry
      // while a live copy may still exist there.
      allResolved = false
      warnings.push(
        `Could not reach the publishing server at ${pdsUrl} to remove the record.`,
      )
    }
  }
  if (!anyDeleted && !allResolved) {
    throw new Error(
      'Could not remove the public record — the publishing server did not answer. The local entry was kept so the removal can be retried.',
    )
  }
  if (!allResolved) {
    throw new Error(
      'The public record may still be live on one publishing server. The local entry was kept so the removal can be retried.',
    )
  }
  dropPublication(recipeId, kv as PublicKv)
  saveSession(session, kv as PublicKv)
  return { pdsUrlsAttempted: targets, warnings }
}
