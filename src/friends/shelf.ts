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

/**
 * Build a fresh key record for `recipeId` WITHOUT saving it (M7
 * rotate atomicity): the caller publishes under the candidate first and
 * only commits it to the vault — via saveRecipeKeyRecord — once every
 * authorized friend holds the new payload. A crash or a failed publish
 * mid-loop therefore leaves the vault on the old key, whose payloads
 * are still valid, instead of stranding friends on envelopes for a key
 * the owner no longer has.
 */
export async function newRecipeKeyRecord(
  prev: RecipeKeyRecord | undefined,
  friends: string[],
): Promise<RecipeKeyRecord> {
  await cryptoReady()
  return {
    keyId: crypto.randomUUID(),
    key: u8ToBase64(sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES)),
    version: (prev?.version ?? 0) + 1,
    friends: [...friends],
  }
}

/** Commit a key record to the vault (the second half of a staged rotate). */
export async function saveRecipeKeyRecord(
  recipeId: string,
  rec: RecipeKeyRecord,
  kv: KeyValueStore = secretKv,
): Promise<void> {
  const vault = loadVault(kv)
  vault[recipeId] = rec
  saveVault(vault, kv)
  // See ensureRecipeKey: the rotated key must be durable before use.
  await flushSecrets()
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
  const vault = loadVault(kv)
  const prev = vault[recipeId]
  const rec = await newRecipeKeyRecord(prev, friends)
  await saveRecipeKeyRecord(recipeId, rec, kv)
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
  /**
   * BLAKE2b-256 hex of the payload ciphertext bytes (M1-sec). The
   * manifest (and the per-recipe manifest entry) binds the exact
   * ciphertext bytes, so a room peer replaying an older payload under
   * the same keyId — or swapping in different bytes — fails the hash
   * check instead of decrypting stale content. Absent on manifests
   * written by pre-fix builds (compat: the hash check is skipped
   * only when neither the ref nor the payload carries one).
   */
  payloadHash?: string
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
  /** BLAKE2b-256 hex of the ciphertext bytes (M1-sec; see ShelfShareRef). */
  payloadHash?: string
  /** base64 secretbox ciphertext (nonce‖ct) of the serialized recipe. */
  ciphertext: string
}

/**
 * One share's manifest entry (M-N1): a single Y.Map key per recipe,
 * signed on its own. Publishing a recipe writes exactly this key — no
 * read of the existing manifest, no rewrite of the whole share list —
 * so two owner devices publishing different recipes to the same friend
 * can no longer race on one manifest key (Yjs map LWW) and lose the
 * loser's share ref while its payload + envelope stay, undiscoverable.
 * The whole-manifest key (`manifest:<did>`) is still written as a
 * legacy index for pre-fix readers, and still read as a fallback, but
 * it is no longer the authoritative record of what is shared.
 */
export interface ShelfManifestEntry {
  did: string
  name: string
  share: ShelfShareRef
  updatedAt: string
  /** Base64 detached Ed25519 signature over the canonical entry bytes. */
  sig: string
}

/** BLAKE2b-256 hex of the raw ciphertext bytes behind a base64 payload. */
export async function payloadHashFor(ciphertextB64: string): Promise<string> {
  await cryptoReady()
  return sodium.to_hex(
    sodium.crypto_generichash(32, base64ToU8(ciphertextB64), null),
  )
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

// --- Per-recipe manifest entries (M-N1) ---------------------------------

export const manifestEntryKey = (did: string, recipeId: string): string =>
  `manifest-entry:${did}:${recipeId}`

/** Canonical bytes a manifest-entry signature covers (everything except `sig`). */
function manifestEntryBytes(e: Omit<ShelfManifestEntry, 'sig'>): Uint8Array {
  return utf8ToU8(
    JSON.stringify({
      did: e.did,
      name: e.name,
      share: e.share,
      updatedAt: e.updatedAt,
    }),
  )
}

export async function buildManifestEntry(
  identity: Identity,
  name: string,
  share: ShelfShareRef,
): Promise<ShelfManifestEntry> {
  const base = {
    did: identity.did,
    name,
    share,
    updatedAt: new Date().toISOString(),
  }
  const sig = await signDetached(identity, manifestEntryBytes(base))
  return { ...base, sig: u8ToBase64(sig) }
}

export async function verifyManifestEntry(e: ShelfManifestEntry): Promise<boolean> {
  if (typeof e.sig !== 'string') return false
  try {
    return await verifyDetached(e.did, manifestEntryBytes(e), base64ToU8(e.sig))
  } catch {
    return false
  }
}

export function readManifestEntry(
  doc: Y.Doc,
  did: string,
  recipeId: string,
): ShelfManifestEntry | null {
  return readJson<ShelfManifestEntry>(doc, manifestEntryKey(did, recipeId))
}

function writeManifestEntry(doc: Y.Doc, e: ShelfManifestEntry): void {
  doc.transact(() => {
    shelfMap(doc).set(manifestEntryKey(e.did, e.share.recipeId), JSON.stringify(e))
  })
}

function deleteManifestEntry(doc: Y.Doc, did: string, recipeId: string): void {
  doc.transact(() => {
    shelfMap(doc).delete(manifestEntryKey(did, recipeId))
  })
}

/**
 * All per-recipe manifest entries in the shelf doc, plus the keys whose
 * values could not be parsed or are not well-formed entries. Unparseable
 * entries are REPORTED (M-N1), never silently skipped the way
 * allManifests used to skip unparseable whole manifests.
 */
export function allManifestEntries(doc: Y.Doc): {
  entries: ShelfManifestEntry[]
  corruptKeys: string[]
} {
  const entries: ShelfManifestEntry[] = []
  const corruptKeys: string[] = []
  shelfMap(doc).forEach((raw, key) => {
    if (!key.startsWith('manifest-entry:') || typeof raw !== 'string') return
    try {
      const e = JSON.parse(raw) as ShelfManifestEntry
      if (
        e &&
        typeof e === 'object' &&
        typeof e.did === 'string' &&
        typeof e.name === 'string' &&
        e.share &&
        typeof e.share === 'object' &&
        typeof (e.share as ShelfShareRef).shareId === 'string' &&
        typeof (e.share as ShelfShareRef).recipeId === 'string' &&
        typeof (e.share as ShelfShareRef).keyId === 'string' &&
        typeof e.sig === 'string'
      ) {
        entries.push(e)
      } else {
        corruptKeys.push(key)
      }
    } catch {
      corruptKeys.push(key)
    }
  })
  return { entries, corruptKeys }
}

/** Whole-manifest (`manifest:<did>`) keys whose value is not valid JSON. */
export function allManifestCorruptKeys(doc: Y.Doc): string[] {
  const out: string[] = []
  shelfMap(doc).forEach((raw, key) => {
    if (!key.startsWith('manifest:') || typeof raw !== 'string') return
    try {
      JSON.parse(raw)
    } catch {
      out.push(key)
    }
  })
  return out
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
  const hash = await payloadHashFor(ciphertext)
  const payload: SharePayloadEntry = {
    shareId: recipeId,
    recipeId,
    ownerDid: identity.did,
    keyId: keyRec.keyId,
    updatedAt: recipe.updatedAt,
    payloadHash: hash,
    ciphertext,
  }
  const envelope: KeyEnvelope = {
    shareId: recipeId,
    recipeId,
    to: friendDid,
    keyId: keyRec.keyId,
    sealedKey,
  }
  const shareRef: ShelfShareRef = {
    shareId: recipeId,
    recipeId,
    keyId: keyRec.keyId,
    updatedAt: recipe.updatedAt,
    payloadHash: hash,
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
  // Authoritative record (M-N1): one signed entry for this recipe only.
  // No read of any existing manifest, so a concurrent publish of a
  // different recipe to the same friend cannot lose this share ref.
  await writeManifestEntry(doc, await buildManifestEntry(identity, myName, shareRef))
  // Legacy whole-manifest index, best-effort: pre-fix readers still
  // need it, but its read-modify-write can no longer lose a share —
  // the per-recipe entry above is authoritative. A corrupt legacy
  // manifest must never fail this publish.
  try {
    const existing = readManifest(doc, identity.did)
    const shares = (existing?.shares ?? []).filter((s) => s.recipeId !== recipeId)
    shares.push(shareRef)
    writeManifest(doc, await buildManifest(identity, myName, shares))
  } catch {
    /* legacy index unavailable — the per-recipe entry stands alone */
  }
}

/** Remove a recipe's payload/envelope/manifest refs from a shelf doc. */
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
  deleteManifestEntry(doc, identity.did, recipeId)
  try {
    const existing = readManifest(doc, identity.did)
    const shares = (existing?.shares ?? []).filter((s) => s.recipeId !== recipeId)
    writeManifest(doc, await buildManifest(identity, myName, shares))
  } catch {
    /* legacy index unavailable — the per-recipe entry is already gone */
  }
  // H6: the friend's next import deletes their local copy on the
  // strength of this signed tombstone. Written on every unpublish path
  // (delete, unfriend, de-authorize) — unpublishShare is exactly "this
  // friend should no longer have this recipe".
  writeTombstone(doc, await buildTombstone(identity, recipeId))
}

/**
 * Is the shelf copy of `recipeId` for `friendDid` exactly the current
 * version — manifest entry (or legacy manifest ref) + payload +
 * envelope all present, all citing `keyId`, payload hash matching?
 * The startup sweep (M1-rel) uses this so a healthy shelf is left
 * untouched and only a missing/stale/mismatched copy is republished.
 */
export function shelfShareIsCurrent(
  doc: Y.Doc,
  ownerDid: string,
  recipeId: string,
  keyId: string,
  friendDid: string,
): boolean {
  const entry = readManifestEntry(doc, ownerDid, recipeId)
  const ref =
    entry?.share ??
    readManifest(doc, ownerDid)?.shares.find((s) => s.recipeId === recipeId)
  if (!ref || ref.keyId !== keyId) return false
  const payload = readPayload(doc, recipeId)
  if (!payload || payload.keyId !== keyId) return false
  if (payload.ownerDid !== ownerDid) return false
  if (ref.payloadHash && payload.payloadHash !== ref.payloadHash) return false
  const envelope = readEnvelope(doc, recipeId, friendDid)
  if (!envelope || envelope.keyId !== keyId || envelope.to !== friendDid) return false
  return true
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
 *
 * Binding (M1-sec): a share is accepted only when the manifest ref, the
 * payload, and the envelope agree on shareId/recipeId/keyId AND on the
 * payload hash — the manifest's payloadHash is the BLAKE2b-256 of the
 * exact ciphertext bytes, so a replayed older payload under the same
 * keyId, or bytes swapped under a current manifest, fails closed. The
 * payload must name the manifest's DID as its owner and the envelope
 * must name me. When `expectedOwnerDid` is given (the friend whose
 * channel this doc is — importReceivedShares always passes it), a
 * manifest from any other DID is rejected: a per-pair channel doc must
 * only ever carry that friend's shares.
 *
 * Sources (M-N1): per-recipe manifest entries are the authoritative
 * record; the legacy whole manifest is still honored for pre-fix docs.
 * A share listed by either source is imported once. But fail-closed
 * cuts both ways: if EITHER source lists a share and fails its
 * signature check, the share is NOT imported via the other source —
 * a tampered legacy manifest still blocks the share, exactly as
 * before. Unparseable manifest keys (either kind) are reported as
 * failures, never silently skipped.
 */
export async function processChannel(
  doc: Y.Doc,
  identity: Identity,
  expectedOwnerDid?: string,
): Promise<{
  received: ReceivedShare[]
  failures: ProcessFailure[]
  tombstones: ShelfTombstone[]
}> {
  const received: ReceivedShare[] = []
  const failures: ProcessFailure[] = []
  const tombstones: ShelfTombstone[] = []
  const liveShares = new Set<string>()
  const fail = (shareId: string, reason: string): void => {
    failures.push({ shareId, reason })
  }

  // One share, possibly listed by two sources: `failed` once set by a
  // bad signature in either source blocks the import outright.
  interface ShareState {
    did: string
    ref: ShelfShareRef
    failed: boolean
  }
  const states = new Map<string, ShareState>()
  const stateKey = (did: string, shareId: string): string => `${did}:${shareId}`
  const addRef = (did: string, ref: ShelfShareRef, ok: boolean, badReason: string): void => {
    const key = stateKey(did, ref.shareId)
    const existing = states.get(key)
    if (!existing) {
      states.set(key, { did, ref, failed: !ok })
      if (!ok) fail(ref.shareId, badReason)
      return
    }
    if (!ok) {
      existing.failed = true
      fail(ref.shareId, badReason)
    }
  }

  // Unparseable manifest keys are failures, not silent skips (M-N1).
  for (const key of allManifestCorruptKeys(doc)) {
    fail(key, 'shelf manifest is unparseable')
  }
  const { entries, corruptKeys } = allManifestEntries(doc)
  for (const key of corruptKeys) {
    fail(key, 'shelf manifest entry is unparseable')
  }

  for (const manifest of allManifests(doc)) {
    if (manifest.did === identity.did) continue
    // One poisoned manifest must never abort the other friends' imports
    // (S7): everything per-manifest runs inside this try, and any throw
    // lands in failures under the manifest's DID — never propagates.
    try {
      if (expectedOwnerDid && manifest.did !== expectedOwnerDid) {
        fail(
          `manifest:${manifest.did}`,
          `manifest from ${manifest.did} is not from the expected friend ${expectedOwnerDid}`,
        )
        continue
      }
      if (!Array.isArray(manifest.shares)) {
        fail(
          `manifest:${manifest.did}`,
          `manifest from ${manifest.did} lists no shares array`,
        )
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
          fail(shareId, `manifest signature from ${manifest.did} did not verify`)
          // Mark the share failed so a per-recipe entry for the same
          // share cannot rescue a tampered whole manifest.
          const ref =
            raw && typeof raw === 'object'
              ? (raw as ShelfShareRef)
              : { shareId, recipeId: shareId, keyId: '', updatedAt: '' }
          const key = stateKey(manifest.did, shareId)
          const existing = states.get(key)
          if (existing) existing.failed = true
          else states.set(key, { did: manifest.did, ref, failed: true })
        }
        continue
      }
      for (const ref of manifest.shares) {
        if (!ref || typeof ref !== 'object' || typeof ref.shareId !== 'string') {
          fail(
            `manifest:${manifest.did}`,
            `manifest from ${manifest.did} lists a malformed share reference`,
          )
          continue
        }
        addRef(manifest.did, ref, true, '')
      }
    } catch (e) {
      fail(
        `manifest:${manifest.did}`,
        `manifest from ${manifest.did} could not be processed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
    }
  }

  for (const entry of entries) {
    if (entry.did === identity.did) continue
    try {
      if (expectedOwnerDid && entry.did !== expectedOwnerDid) {
        fail(
          `manifest:${entry.did}`,
          `manifest entry from ${entry.did} is not from the expected friend ${expectedOwnerDid}`,
        )
        const key = stateKey(entry.did, entry.share.shareId)
        const existing = states.get(key)
        if (existing) existing.failed = true
        else
          states.set(key, { did: entry.did, ref: entry.share, failed: true })
        continue
      }
      const ok = await verifyManifestEntry(entry)
      addRef(
        entry.did,
        entry.share,
        ok,
        `manifest entry signature from ${entry.did} did not verify`,
      )
    } catch (e) {
      fail(
        `manifest:${entry.did}`,
        `manifest entry from ${entry.did} could not be processed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
    }
  }

  for (const state of states.values()) {
    if (state.failed) continue
    const { did, ref } = state
    try {
      const payload = readPayload(doc, ref.shareId)
      if (!payload) {
        fail(ref.shareId, 'payload missing from shelf')
        continue
      }
      const envelope = readEnvelope(doc, ref.shareId, identity.did)
      if (!envelope) {
        fail(ref.shareId, 'no key envelope addressed to me (not authorized)')
        continue
      }
      if (envelope.keyId !== payload.keyId || envelope.keyId !== ref.keyId) {
        fail(ref.shareId, 'key id mismatch between manifest, payload, and envelope')
        continue
      }
      // DID + content binding (M1-sec): the payload must be the exact
      // bytes the manifest vouches for, owned by the manifest's DID.
      if (payload.ownerDid !== did) {
        fail(ref.shareId, 'payload owner does not match the manifest DID')
        continue
      }
      if (payload.shareId !== ref.shareId || payload.recipeId !== ref.recipeId) {
        fail(ref.shareId, 'payload does not match the manifest reference')
        continue
      }
      if (payload.updatedAt !== ref.updatedAt) {
        fail(ref.shareId, 'payload version does not match the manifest')
        continue
      }
      if (envelope.to !== identity.did) {
        fail(ref.shareId, 'key envelope is not addressed to me')
        continue
      }
      if (ref.payloadHash) {
        if (!payload.payloadHash || payload.payloadHash !== ref.payloadHash) {
          fail(ref.shareId, 'payload hash does not match the manifest')
          continue
        }
        const actual = await payloadHashFor(payload.ciphertext)
        if (actual !== ref.payloadHash) {
          fail(ref.shareId, 'payload bytes do not match the manifest hash')
          continue
        }
      } else if (payload.payloadHash) {
        const actual = await payloadHashFor(payload.ciphertext)
        if (actual !== payload.payloadHash) {
          fail(ref.shareId, 'payload bytes do not match the payload hash')
          continue
        }
      }
      try {
        const keyB64 = await unwrapKey(identity, envelope.sealedKey)
        const recipe = await decryptRecipePayload(keyB64, payload.ciphertext)
        received.push({
          ownerDid: did,
          ownerName:
            entries.find((e) => e.did === did)?.name ??
            allManifests(doc).find((m) => m.did === did)?.name ??
            '',
          shareId: ref.shareId,
          recipeId: ref.recipeId,
          keyId: ref.keyId,
          updatedAt: payload.updatedAt,
          recipe,
        })
      } catch (e) {
        fail(
          ref.shareId,
          `decryption failed: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    } catch (e) {
      fail(
        ref.shareId,
        `share from ${did} could not be processed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      )
    }
  }
  // Live shares win over tombstones (H6): a recipe listed by a verified
  // manifest ref — from either source — is currently shared, so a
  // tombstone for it is stale and must not delete it.
  for (const state of states.values()) {
    if (!state.failed && typeof state.ref.recipeId === 'string') {
      liveShares.add(`${state.did}:${state.ref.recipeId}`)
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
