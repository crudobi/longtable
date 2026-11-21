/**
 * Friends-only sharing — the shelf.
 *
 * Each friend pair shares one "shelf" Y.Doc (see friends.ts channels).
 * Everything an owner publishes into a shelf is encrypted before it lands:
 *
 *   - Recipe content: serialized JSON encrypted with a per-recipe symmetric
 *     key (libsodium secretbox / XSalsa20-Poly1305, random nonce per version).
 *   - Key delivery: the recipe key is wrapped per friend with a sealed box
 *     (crypto_box_seal) to the friend's DID — only that friend's device can
 *     open it. The envelope is the ONLY path to the key.
 *   - Discovery: a signed shelf manifest lists share ids + key ids (no
 *     titles, no content). Friends verify the owner's signature before
 *     trusting anything in the shelf.
 *
 * Visibility is enforced by where bytes go: a recipe's ciphertext is only
 * ever written into the shelf docs of its authorized friends, and each key
 * envelope is sealed to one friend. The signaling server and TURN only
 * ever carry WebRTC ciphertext; plaintext never leaves the owner's device
 * unencrypted, and never touches any public/ATProto surface.
 *
 * Unfriend / revocation = re-key: a fresh recipe key is generated, content
 * is re-encrypted, and envelopes are issued only to the remaining friends.
 * The revoked friend keeps whatever old ciphertext+key they already had
 * (they can still read the OLD version — that is inherent), but every new
 * version is undecryptable to them: no envelope, no key, no plaintext.
 *
 * Delete / unshare / unfriend = tombstone (H6): removing a recipe from a
 * friend's shelf ALSO writes a signed tombstone into the channel doc
 * (`tombstone:<recipeId>`). The friend's next import verifies the
 * signature and deletes their local copy + its received-shares mapping —
 * deleting here finally removes the recipient's copy instead of leaving
 * a stale one they can re-share. Best-effort only, and the code says so
 * where it matters: a friend whose device never syncs again keeps their
 * copy; a friend who saved a PUBLIC copy (no channel to them) is
 * unreachable by any tombstone; a P2P guest's persisted doc is out of
 * reach once the room is left (Wave 2 stops the live updates, not the
 * guest's disk). Re-sharing a recipe clears its tombstone first, so a
 * tombstone can never delete a live share.
 */
import * as Y from 'yjs'
import sodium from 'libsodium-wrappers'
import {
  cryptoReady,
  encPublicKeyForDid,
  signDetached,
  verifyDetached,
  type Identity,
  type KeyValueStore,
} from '../identity/identity'
import { flushSecrets, secretKv } from '../secrets/secretStore'
import {
  assertStoreWritable,
  noteCorruptStore,
  readStoredJson,
} from '../store/corrupt'
import {
  base64ToU8,
  u8ToBase64,
  u8ToUtf8,
  utf8ToU8,
} from '../identity/codec'
import type { Recipe } from '../types'

export const VAULT_KEY = 'longtable:key-vault'
const SHELF_MAP = 'shelf'

// ---------------------------------------------------------------------------
// Key vault (owner-side, local only — never synced)
// ---------------------------------------------------------------------------

export interface RecipeKeyRecord {
  /** Opaque id for this key version (`<uuid>`). Payloads/envelopes cite it. */
  keyId: string
  /** Base64 32-byte symmetric key. */
  key: string
  /** Monotonic version, 1-based; increments on every re-key. */
  version: number
  /** DIDs currently authorized to receive envelopes for this key. */
  friends: string[]
}

export type KeyVault = Record<string, RecipeKeyRecord>

/** One vault entry is usable only when all of its fields check out. */
function isRecipeKeyRecord(o: unknown): o is RecipeKeyRecord {
  if (typeof o !== 'object' || o === null) return false
  const r = o as Record<string, unknown>
  return (
    typeof r.keyId === 'string' &&
    typeof r.key === 'string' &&
    typeof r.version === 'number' &&
    Array.isArray(r.friends) &&
    r.friends.every((d) => typeof d === 'string')
  )
}

/**
 * Load the key vault (H9). Absent reads as empty; corrupt JSON — or a
 * top-level value that is not an object — is quarantined (bytes
 * preserved, see src/store/corrupt.ts) and reads as empty. Entries
 * that fail validation are dropped individually: one bad entry never
 * wipes the other recipes' keys.
 */
export function loadVault(kv: KeyValueStore = secretKv): KeyVault {
  const read = readStoredJson(kv, VAULT_KEY)
  if (read.status === 'absent') return {}
  if (read.status === 'corrupt') return {}
  const obj = read.value
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    noteCorruptStore(kv, VAULT_KEY, read.raw, 'not a JSON object')
    return {}
  }
  const out: KeyVault = {}
  for (const [recipeId, rec] of Object.entries(obj as Record<string, unknown>)) {
    if (isRecipeKeyRecord(rec)) out[recipeId] = rec
  }
  return out
}

/**
 * Persist the vault. Refuses (throws CorruptStoreError) when the stored
 * vault is corrupt: a load-then-save round-trip must never persist an
 * empty vault over the damaged bytes. Backup restore clears the
 * corruption record first — it is the deliberate replacement path.
 */
export function saveVault(vault: KeyVault, kv: KeyValueStore = secretKv): void {
  assertStoreWritable(VAULT_KEY)
  kv.setItem(VAULT_KEY, JSON.stringify(vault))
}

export function getRecipeKey(
  recipeId: string,
  kv: KeyValueStore = secretKv,
): RecipeKeyRecord | undefined {
  return loadVault(kv)[recipeId]
}

/** Get the recipe's current key, creating version 1 on first share. */
export async function ensureRecipeKey(
  recipeId: string,
  kv: KeyValueStore = secretKv,
): Promise<RecipeKeyRecord> {
  const vault = loadVault(kv)
  const existing = vault[recipeId]
  if (existing) return existing
  await cryptoReady()
  const rec: RecipeKeyRecord = {
    keyId: crypto.randomUUID(),
    key: u8ToBase64(sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES)),
    version: 1,
    friends: [],
  }
  vault[recipeId] = rec
  saveVault(vault, kv)
  // The vault holds crown-jewel keys: await the Keystore flush so the
  // new key is durable before the caller publishes under it.
  await flushSecrets()
  return rec
}

/**
 * Rotate a recipe's key: fresh key + keyId, version+1, authorized set
 * replaced by `friends`. Old envelopes become useless for new payloads
 * because new payloads cite the new keyId and are encrypted under it.
 */
export async function rotateRecipeKey(
  recipeId: string,
  friends: string[],
  kv: KeyValueStore = secretKv,
): Promise<RecipeKeyRecord> {
  await cryptoReady()
  const vault = loadVault(kv)
  const prev = vault[recipeId]
  const rec: RecipeKeyRecord = {
    keyId: crypto.randomUUID(),
    key: u8ToBase64(sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES)),
    version: (prev?.version ?? 0) + 1,
    friends: [...friends],
  }
  vault[recipeId] = rec
  saveVault(vault, kv)
  // See ensureRecipeKey: the rotated key must be durable before use.
  await flushSecrets()
  return rec
}

/** Record the authorized friend set for the recipe's current key. */
export function setKeyFriends(
  recipeId: string,
  friends: string[],
  kv: KeyValueStore = secretKv,
): void {
  const vault = loadVault(kv)
  const rec = vault[recipeId]
  if (!rec) return
  rec.friends = [...friends]
  saveVault(vault, kv)
}

export function dropRecipeKey(
  recipeId: string,
  kv: KeyValueStore = secretKv,
): void {
  const vault = loadVault(kv)
  delete vault[recipeId]
  saveVault(vault, kv)
}

// ---------------------------------------------------------------------------
// Recipe encryption (symmetric, per-recipe key sealed per friend)
// ---------------------------------------------------------------------------

/** Encrypt a recipe under a base64 symmetric key. Output: base64(nonce‖ct). */
export async function encryptRecipePayload(
  keyB64: string,
  recipe: Recipe,
): Promise<string> {
  await cryptoReady()
  const key = base64ToU8(keyB64)
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
  const ct = sodium.crypto_secretbox_easy(utf8ToU8(JSON.stringify(recipe)), nonce, key)
  const out = new Uint8Array(nonce.length + ct.length)
  out.set(nonce, 0)
  out.set(ct, nonce.length)
  return u8ToBase64(out)
}

/** Decrypt a payload produced by encryptRecipePayload. Throws on failure. */
export async function decryptRecipePayload(
  keyB64: string,
  payloadB64: string,
): Promise<Recipe> {
  await cryptoReady()
  const key = base64ToU8(keyB64)
  const raw = base64ToU8(payloadB64)
  const nonce = raw.slice(0, sodium.crypto_secretbox_NONCEBYTES)
  const ct = raw.slice(sodium.crypto_secretbox_NONCEBYTES)
  const plain = sodium.crypto_secretbox_open_easy(ct, nonce, key)
  return JSON.parse(u8ToUtf8(plain)) as Recipe
}

/** Wrap (seal) a base64 recipe key to a friend's DID. Only they can open it. */
export async function wrapKeyForDid(keyB64: string, friendDid: string): Promise<string> {
  await cryptoReady()
  const encPk = await encPublicKeyForDid(friendDid)
  return u8ToBase64(sodium.crypto_box_seal(base64ToU8(keyB64), encPk))
}

/**
 * Open a sealed key envelope addressed to `identity`. Throws (libsodium
 * "incorrect MAC" / verification error) when the envelope was sealed to
 * anyone else — this throw is the explicit stranger failure the oath needs.
 */
export async function unwrapKey(identity: Identity, sealedB64: string): Promise<string> {
  await cryptoReady()
  const opened = sodium.crypto_box_seal_open(
    base64ToU8(sealedB64),
    identity.encPublicKey,
    identity.encSecretKey,
  )
  return u8ToBase64(opened)
}

// ---------------------------------------------------------------------------
// Shelf document entries
// ---------------------------------------------------------------------------

export interface ShelfShareRef {
  shareId: string
  recipeId: string
  keyId: string
  updatedAt: string
}

export interface ShelfManifest {
  did: string
  name: string
  shares: ShelfShareRef[]
  updatedAt: string
  /** Base64 detached Ed25519 signature over the canonical manifest bytes. */
  sig: string
}

export interface SharePayloadEntry {
  shareId: string
  recipeId: string
  ownerDid: string
  keyId: string
  updatedAt: string
  /** base64 secretbox ciphertext (nonce‖ct) of the serialized recipe. */
  ciphertext: string
}

export interface KeyEnvelope {
  shareId: string
  recipeId: string
  /** DID this envelope is sealed to; everyone else may read the bytes but
   *  cannot open them. */
  to: string
  keyId: string
  /** Base64 sealed box containing the recipe key. */
  sealedKey: string
}

/**
 * A delete tombstone (H6): the owner's signed statement "I deleted this
 * recipe — delete your received copy too". Stored under
 * `tombstone:<recipeId>` in the friend's shelf doc. Signed exactly like
 * the manifest (detached Ed25519 over a canonical message), so a relay
 * or a third party in the room cannot forge a deletion for someone
 * else's recipe — the recipient verifies the signature against the
 * owner's DID before acting on it.
 */
export interface ShelfTombstone {
  recipeId: string
  ownerDid: string
  /** ISO-8601 time of the delete (also binds the signature). */
  deletedAt: string
  /** Base64 detached Ed25519 signature over tombstoneMessage. */
  sig: string
}

/** The exact bytes a tombstone signature covers. */
export function tombstoneMessage(
  ownerDid: string,
  recipeId: string,
  deletedAt: string,
): string {
  return `longtable-tombstone:v1\n${ownerDid}\n${recipeId}\n${deletedAt}`
}

/** Sign a tombstone for `recipeId` as `identity`. */
export async function buildTombstone(
  identity: Identity,
  recipeId: string,
): Promise<ShelfTombstone> {
  const deletedAt = new Date().toISOString()
  const sig = await signDetached(
    identity,
    utf8ToU8(tombstoneMessage(identity.did, recipeId, deletedAt)),
  )
  return { recipeId, ownerDid: identity.did, deletedAt, sig: u8ToBase64(sig) }
}

/** True only when the tombstone is well-shaped and its signature verifies. */
export async function verifyTombstone(t: ShelfTombstone): Promise<boolean> {
  if (
    !t ||
    typeof t !== 'object' ||
    typeof t.recipeId !== 'string' ||
    !t.recipeId ||
    typeof t.ownerDid !== 'string' ||
    !t.ownerDid ||
    typeof t.deletedAt !== 'string' ||
    !t.deletedAt ||
    typeof t.sig !== 'string'
  ) {
    return false
  }
  try {
    return await verifyDetached(
      t.ownerDid,
      utf8ToU8(tombstoneMessage(t.ownerDid, t.recipeId, t.deletedAt)),
      base64ToU8(t.sig),
    )
  } catch {
    return false
  }
}

const manifestKey = (did: string) => `manifest:${did}`
const payloadKey = (shareId: string) => `payload:${shareId}`
const envelopeKey = (shareId: string, toDid: string) => `envelope:${shareId}:${toDid}`
const tombstoneKey = (recipeId: string) => `tombstone:${recipeId}`

function shelfMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap(SHELF_MAP)
}

function readJson<T>(doc: Y.Doc, key: string): T | null {
  const raw = shelfMap(doc).get(key)
  if (typeof raw !== 'string') return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** Canonical bytes a manifest signature covers (everything except `sig`). */
function manifestBytes(m: Omit<ShelfManifest, 'sig'>): Uint8Array {
  return utf8ToU8(
    JSON.stringify({
      did: m.did,
      name: m.name,
      shares: m.shares,
      updatedAt: m.updatedAt,
    }),
  )
}

export async function buildManifest(
  identity: Identity,
  name: string,
  shares: ShelfShareRef[],
): Promise<ShelfManifest> {
  const base = {
    did: identity.did,
    name,
    shares,
    updatedAt: new Date().toISOString(),
  }
  const sig = await signDetached(identity, manifestBytes(base))
  return { ...base, sig: u8ToBase64(sig) }
}

export async function verifyManifest(m: ShelfManifest): Promise<boolean> {
  if (typeof m.sig !== 'string') return false
  try {
    // base64ToU8 throws on a non-base64 sig (atob) — that is an
    // unverifiable manifest, never a throw (S7): the caller records a
    // failure and keeps importing the other friends' shares.
    return await verifyDetached(m.did, manifestBytes(m), base64ToU8(m.sig))
  } catch {
    return false
  }
}

export function readManifest(doc: Y.Doc, did: string): ShelfManifest | null {
  return readJson<ShelfManifest>(doc, manifestKey(did))
}

function writeManifest(doc: Y.Doc, m: ShelfManifest): void {
  doc.transact(() => {
    shelfMap(doc).set(manifestKey(m.did), JSON.stringify(m))
  })
}

export function readPayload(doc: Y.Doc, shareId: string): SharePayloadEntry | null {
  return readJson<SharePayloadEntry>(doc, payloadKey(shareId))
}

export function readEnvelope(
  doc: Y.Doc,
  shareId: string,
  toDid: string,
): KeyEnvelope | null {
  return readJson<KeyEnvelope>(doc, envelopeKey(shareId, toDid))
}

/** All DID→manifest entries currently in the shelf doc. */
export function allManifests(doc: Y.Doc): ShelfManifest[] {
  const out: ShelfManifest[] = []
  shelfMap(doc).forEach((raw, key) => {
    if (!key.startsWith('manifest:') || typeof raw !== 'string') return
    try {
      out.push(JSON.parse(raw) as ShelfManifest)
    } catch {
      /* skip corrupt */
    }
  })
  return out
}

/** All tombstones currently in the shelf doc (unverified — verify before acting). */
export function readTombstones(doc: Y.Doc): ShelfTombstone[] {
  const out: ShelfTombstone[] = []
  shelfMap(doc).forEach((raw, key) => {
    if (!key.startsWith('tombstone:') || typeof raw !== 'string') return
    try {
      out.push(JSON.parse(raw) as ShelfTombstone)
    } catch {
      /* skip corrupt */
    }
  })
  return out
}

/** Write (or overwrite) one tombstone in the shelf doc. */
export function writeTombstone(doc: Y.Doc, tombstone: ShelfTombstone): void {
  doc.transact(() => {
    shelfMap(doc).set(tombstoneKey(tombstone.recipeId), JSON.stringify(tombstone))
  })
}

/** Clear a recipe's tombstone (re-share: the recipe is live again). */
export function deleteTombstone(doc: Y.Doc, recipeId: string): void {
  doc.transact(() => {
    shelfMap(doc).delete(tombstoneKey(recipeId))
  })
}

// ---------------------------------------------------------------------------
// Publishing (owner side) and processing (friend side)
// ---------------------------------------------------------------------------

/**
 * Publish (or republish) a recipe into one friend's shelf doc: fresh
 * ciphertext under the current key, a key envelope sealed to that friend,
 * and an updated signed manifest. `shareIdFor` is the owner's recipe id —
 * one payload per recipe per channel.
 */
export async function publishShare(
  doc: Y.Doc,
  identity: Identity,
  myName: string,
  recipe: Recipe,
  recipeId: string,
  keyRec: RecipeKeyRecord,
  friendDid: string,
): Promise<void> {
  const ciphertext = await encryptRecipePayload(keyRec.key, recipe)
  const sealedKey = await wrapKeyForDid(keyRec.key, friendDid)
  const payload: SharePayloadEntry = {
    shareId: recipeId,
    recipeId,
    ownerDid: identity.did,
    keyId: keyRec.keyId,
    updatedAt: recipe.updatedAt,
    ciphertext,
  }
  const envelope: KeyEnvelope = {
    shareId: recipeId,
    recipeId,
    to: friendDid,
    keyId: keyRec.keyId,
    sealedKey,
  }
  doc.transact(() => {
    const map = shelfMap(doc)
    map.set(payloadKey(recipeId), JSON.stringify(payload))
    map.set(envelopeKey(recipeId, friendDid), JSON.stringify(envelope))
  })
  // Re-sharing clears any tombstone for this recipe (H6): a tombstone
  // must never delete a live share — and the friend's next import would
  // otherwise apply the stale tombstone to the fresh copy.
  deleteTombstone(doc, recipeId)
  // Refresh my manifest, preserving other shares already listed in it.
  const existing = readManifest(doc, identity.did)
  const shares = (existing?.shares ?? []).filter((s) => s.recipeId !== recipeId)
  shares.push({
    shareId: recipeId,
    recipeId,
    keyId: keyRec.keyId,
    updatedAt: recipe.updatedAt,
  })
  writeManifest(doc, await buildManifest(identity, myName, shares))
}

/** Remove a recipe's payload/envelope/manifest ref from a shelf doc. */
export async function unpublishShare(
  doc: Y.Doc,
  identity: Identity,
  myName: string,
  recipeId: string,
  friendDid: string,
): Promise<void> {
  doc.transact(() => {
    const map = shelfMap(doc)
    map.delete(payloadKey(recipeId))
    map.delete(envelopeKey(recipeId, friendDid))
  })
  const existing = readManifest(doc, identity.did)
  const shares = (existing?.shares ?? []).filter((s) => s.recipeId !== recipeId)
  writeManifest(doc, await buildManifest(identity, myName, shares))
  // H6: the friend's next import deletes their local copy on the
  // strength of this signed tombstone. Written on every unpublish path
  // (delete, unfriend, de-authorize) — unpublishShare is exactly "this
  // friend should no longer have this recipe".
  writeTombstone(doc, await buildTombstone(identity, recipeId))
}

export interface ReceivedShare {
  ownerDid: string
  ownerName: string
  shareId: string
  recipeId: string
  keyId: string
  updatedAt: string
  recipe: Recipe
}

export interface ProcessFailure {
  shareId: string
  /** Human-readable reason (no envelope / MAC failure / bad signature…). */
  reason: string
}

/**
 * Process a shelf doc as `identity`: for every OTHER party's manifest,
 * verify its signature, then for each listed share open my key envelope
 * and decrypt the payload. Anything I am not authorized for lands in
 * `failures` with an explicit reason — never silently, never partially.
 *
 * Also returns the doc's verified `tombstones` (H6): signed delete
 * notices from other parties. The caller (service.ts) deletes the
 * matching local received copies. A tombstone that fails verification
 * lands in `failures` and is NOT acted on — a forged deletion deletes
 * nothing. A tombstone for a recipe that is ALSO listed as a live share
 * in the same doc is skipped: the live share wins (the owner re-shared
 * after deleting, and the tombstone is stale).
 */
export async function processChannel(
  doc: Y.Doc,
  identity: Identity,
): Promise<{
  received: ReceivedShare[]
  failures: ProcessFailure[]
  tombstones: ShelfTombstone[]
}> {
  const received: ReceivedShare[] = []
  const failures: ProcessFailure[] = []
  const tombstones: ShelfTombstone[] = []
  const liveShares = new Set<string>()
  for (const manifest of allManifests(doc)) {
    if (manifest.did === identity.did) continue
    // One poisoned manifest must never abort the other friends' imports
    // (S7): everything per-manifest runs inside this try, and any throw
    // lands in failures under the manifest's DID — never propagates.
    try {
      if (!Array.isArray(manifest.shares)) {
        failures.push({
          shareId: `manifest:${manifest.did}`,
          reason: `manifest from ${manifest.did} lists no shares array`,
        })
        continue
      }
      if (!(await verifyManifest(manifest))) {
        for (const raw of manifest.shares) {
          const shareId =
            raw &&
            typeof raw === 'object' &&
            typeof (raw as { shareId?: unknown }).shareId === 'string'
              ? (raw as { shareId: string }).shareId
              : `manifest:${manifest.did}`
          failures.push({
            shareId,
            reason: `manifest signature from ${manifest.did} did not verify`,
          })
        }
        continue
      }
      for (const ref of manifest.shares) {
        if (!ref || typeof ref !== 'object' || typeof ref.shareId !== 'string') {
          failures.push({
            shareId: `manifest:${manifest.did}`,
            reason: `manifest from ${manifest.did} lists a malformed share reference`,
          })
          continue
        }
        // Live shares win over tombstones (H6): a recipe listed here is
        // currently shared, so a tombstone for it — from an earlier
        // delete before a re-share — is stale and must not delete it.
        if (typeof ref.recipeId === 'string') {
          liveShares.add(`${manifest.did}:${ref.recipeId}`)
        }
        const payload = readPayload(doc, ref.shareId)
        if (!payload) {
          failures.push({ shareId: ref.shareId, reason: 'payload missing from shelf' })
          continue
        }
        const envelope = readEnvelope(doc, ref.shareId, identity.did)
        if (!envelope) {
          failures.push({
            shareId: ref.shareId,
            reason: 'no key envelope addressed to me (not authorized)',
          })
          continue
        }
        if (envelope.keyId !== payload.keyId || envelope.keyId !== ref.keyId) {
          failures.push({
            shareId: ref.shareId,
            reason: 'key id mismatch between manifest, payload, and envelope',
          })
          continue
        }
        try {
          const keyB64 = await unwrapKey(identity, envelope.sealedKey)
          const recipe = await decryptRecipePayload(keyB64, payload.ciphertext)
          received.push({
            ownerDid: manifest.did,
            ownerName: manifest.name,
            shareId: ref.shareId,
            recipeId: ref.recipeId,
            keyId: ref.keyId,
            updatedAt: payload.updatedAt,
            recipe,
          })
        } catch (e) {
          failures.push({
            shareId: ref.shareId,
            reason: `decryption failed: ${e instanceof Error ? e.message : String(e)}`,
          })
        }
      }
    } catch (e) {
      failures.push({
        shareId: `manifest:${manifest.did}`,
        reason: `manifest from ${manifest.did} could not be processed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      })
    }
  }
  // Tombstones (H6): verified, from other parties, and not for a recipe
  // that is live-shared in this same doc. Unverifiable tombstones are
  // failures, never actions.
  for (const t of readTombstones(doc)) {
    if (t.ownerDid === identity.did) continue
    if (!(await verifyTombstone(t))) {
      failures.push({
        shareId: t.recipeId || `tombstone:${t.ownerDid}`,
        reason: `tombstone from ${t.ownerDid} did not verify — the delete was not applied`,
      })
      continue
    }
    if (liveShares.has(`${t.ownerDid}:${t.recipeId}`)) continue
    tombstones.push(t)
  }
  return { received, failures, tombstones }
}
