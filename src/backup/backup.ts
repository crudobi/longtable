/**
 * Encrypted backup + restore — Wave 3 C3 (the standing data-loss Critical).
 *
 * One file holds everything a phone loss would otherwise destroy:
 * the identity key (so the DID survives), the display name, friends +
 * pair secrets, the key vault, P2P share records, the received-shares
 * mapping, every recipe (with original ids and timestamps), and every
 * friend-channel shelf document (so shares a friend sent me survive
 * even while they are offline).
 *
 * Design decisions (each made here, documented here — see docs/backup.md
 * for the full write-up):
 *
 * - Encryption: libsodium secretbox (XSalsa20-Poly1305) over a JSON
 *   plaintext, keyed by Argon2id. The brief's "libsodium pwhash" needs
 *   a correction: the pinned `libsodium-wrappers@0.8.4` STANDARD build
 *   ships NO `crypto_pwhash` at all (verified at runtime: every
 *   `crypto_pwhash*` member is `undefined`, as are scrypt and
 *   HMAC-SHA256 — the standard build omits them; friends.ts already
 *   notes the sha256 omission). So this module adds the SUMO build
 *   (`libsodium-wrappers-sumo@0.8.4`, same libsodium, full function
 *   set) as a dependency, imported DYNAMICALLY so the main bundle —
 *   and the rest of the app, which stays on the standard build — is
 *   untouched. Only the backup code paths ever load sumo.
 * - KDF: Argon2id, libsodium MODERATE preset — opsLimit 3, memLimit
 *   256 MiB, 16-byte random salt, 32-byte key. Measured on the build
 *   machine: ~430 ms (INTERACTIVE ~80 ms, SENSITIVE ~2.2 s). MODERATE
 *   is the right weight for a one-shot user action guarding an identity
 *   key. The ops/mem limits are stored in the file, so a future version
 *   can raise them; restore enforces sane bounds (ops 1–10, mem
 *   8 MiB–1 GiB) BEFORE deriving, so a crafted file cannot force a
 *   multi-gigabyte allocation.
 * - Passphrase: entered by the user at create and at restore, kept only
 *   in the panel's component state for the duration of the operation,
 *   never written to storage, never logged. Minimum 8 characters at
 *   create. There is no recovery: a forgotten passphrase means the
 *   backup cannot be opened, and the UI says so in plain words.
 * - Fail-closed restore: decrypt (secretbox MAC) → full structural
 *   validation (identity DID re-derived from the secret key, recipe
 *   contents re-validated, shelf updates trial-applied to scratch docs,
 *   share rooms re-derived) → ONLY then wipe local state and write.
 *   A wrong passphrase and a corrupt file are indistinguishable by
 *   construction (both fail the MAC) and get the same message; nothing
 *   is ever partially imported. Validation happens before ANY write,
 *   so a backup that fails validation leaves local state untouched.
 * - Replace, not merge: restore REPLACES local state (after the UI's
 *   explicit confirmation). Merging would duplicate recipes and could
 *   keep a stale identity key alongside the restored one — two DIDs on
 *   one device is exactly the conflict a backup must not create.
 * - Shares: share records restore verbatim (same room, same secret, same
 *   role), and the vault keys + shelf docs they depend on restore with
 *   them — so a friends-only recipe keeps working with no re-pairing.
 *   A share record whose recipe is missing from the backup is an orphan
 *   (the delete flow removes the record with the recipe, so this should
 *   not happen); it is dropped at restore and counted in the report,
 *   never silently kept. Same for received-mapping entries whose local
 *   recipe is gone — the mapping is only an upsert cache, and a dropped
 *   entry is rebuilt the next time that share is imported.
 *
 * NOT in the backup (deliberate, documented in docs/backup.md): hub
 * configuration (re-enterable), the ATProto publishing session (a login,
 * re-created by signing in), public PDS records (they live on the PDS,
 * not on the device), and the stable Yjs client id (device-local,
 * regenerable).
 */
import * as Y from 'yjs'
import sodium from 'libsodium-wrappers'
import {
  cryptoReady,
  didFromPublicKey,
  restoreIdentitySecret,
  type Identity,
  type KeyValueStore,
} from '../identity/identity'
import { base64ToU8, u8ToBase64, utf8ToU8, u8ToUtf8 } from '../identity/codec'
import { FRIENDS_KEY, listFriends, removeFriend, saveFriendsList, shelfGuidFor, disconnectAllFriendChannels, type FriendRecord } from '../friends/friends'
import { RECEIVED_KEY, getDisplayName, loadReceivedMap, saveReceivedMap, setDisplayName } from '../friends/service'
import { VAULT_KEY, loadVault, saveVault, type KeyVault } from '../friends/shelf'
import { SHARES_KEY, destroyAllShareProviders, listShares, roomForRecipe, saveShares, type ShareRecord } from '../p2p/share'
import {
  clearCorruptStore,
  corruptStoreLabel,
  isStoreCorrupt,
} from '../store/corrupt'
import {
  deleteRecipe,
  getOrCreateIndex,
  getRecipe,
  listRecipes,
  restoreRecipe,
  sanitizeRecipeInput,
} from '../store/recipes'
import { getOrCreateDoc, type YjsStore } from '../store/repo'
import type { Recipe, RecipeInput } from '../types'

export const BACKUP_FORMAT = 'longtable-backup' as const
export const BACKUP_VERSION = 1 as const
export const BACKUP_KDF = 'argon2id' as const
/** Minimum passphrase length enforced when CREATING a backup. */
export const BACKUP_MIN_PASSPHRASE = 8
/** KDF bounds enforced on restore before any derivation (DoS guard). */
export const BACKUP_KDF_OPS_MIN = 1
export const BACKUP_KDF_OPS_MAX = 10
export const BACKUP_KDF_MEM_MIN = 8 * 1024 * 1024
export const BACKUP_KDF_MEM_MAX = 1024 * 1024 * 1024

export class BackupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupError'
  }
}

/** The encrypted file, as stored (JSON). The ciphertext is the whole story. */
export interface BackupFileV1 {
  format: typeof BACKUP_FORMAT
  version: typeof BACKUP_VERSION
  kdf: typeof BACKUP_KDF
  opsLimit: number
  memLimit: number
  /** Base64 16-byte Argon2id salt. */
  salt: string
  /** Base64 24-byte secretbox nonce. */
  nonce: string
  /** Base64 secretbox ciphertext of the plaintext JSON. */
  ciphertext: string
}

/** One recipe as stored inside the backup (id + full content). */
export interface BackupRecipe extends Recipe {
  id: string
}

/** One friend-channel shelf document, as a Yjs state update. */
export interface BackupShelf {
  friendDid: string
  guid: string
  /** Base64 Yjs state update for the whole shelf doc. */
  update: string
}

/** The decrypted backup payload. */
export interface BackupPlaintextV1 {
  format: typeof BACKUP_FORMAT
  version: typeof BACKUP_VERSION
  exportedAt: string
  displayName: string
  identity: { did: string; secretKey: string }
  friends: FriendRecord[]
  vault: KeyVault
  shares: ShareRecord[]
  received: Record<string, { localId: string; updatedAt: string }>
  recipes: BackupRecipe[]
  shelves: BackupShelf[]
}

export interface RestoreReport {
  did: string
  exportedAt: string
  recipes: number
  friends: number
  shares: number
  vaultEntries: number
  shelves: number
  /** Orphan share records dropped (recipe missing from the backup). */
  droppedShares: number
  /** Received-mapping entries dropped (local recipe missing). */
  droppedReceived: number
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

function isDid(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('did:key:z')
}

/** Decode base64, throwing BackupError (never a raw atob error) on bad input. */
function b64(v: unknown, what: string): Uint8Array {
  if (typeof v !== 'string' || !v) throw new BackupError(`Backup is damaged: ${what} is missing.`)
  try {
    return base64ToU8(v)
  } catch {
    throw new BackupError(`Backup is damaged: ${what} is not valid base64.`)
  }
}

/** The sumo build, loaded on demand (see module header). */
async function loadSumo() {
  const mod = await import('libsodium-wrappers-sumo')
  const sumo = mod.default
  await sumo.ready
  return sumo
}

function assertPassphrase(passphrase: unknown): asserts passphrase is string {
  if (typeof passphrase !== 'string' || passphrase.length < BACKUP_MIN_PASSPHRASE) {
    throw new BackupError(
      `Choose a passphrase of at least ${BACKUP_MIN_PASSPHRASE} characters — ` +
        'it is the only thing protecting this backup, and there is no way to recover it.',
    )
  }
}

/**
 * Encrypt a validated plaintext payload into a backup file (JSON text).
 * The passphrase is used only to derive the key; it is never stored.
 */
export async function createEncryptedBackup(
  plain: BackupPlaintextV1,
  passphrase: string,
): Promise<string> {
  assertPassphrase(passphrase)
  const sumo = await loadSumo()
  await cryptoReady()
  const salt = sodium.randombytes_buf(sumo.crypto_pwhash_SALTBYTES)
  const key = sumo.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    sodium.from_string(passphrase),
    salt,
    sumo.crypto_pwhash_OPSLIMIT_MODERATE,
    sumo.crypto_pwhash_MEMLIMIT_MODERATE,
    sumo.crypto_pwhash_ALG_ARGON2ID13,
  )
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES)
  const ct = sodium.crypto_secretbox_easy(utf8ToU8(JSON.stringify(plain)), nonce, key)
  const file: BackupFileV1 = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    kdf: BACKUP_KDF,
    opsLimit: sumo.crypto_pwhash_OPSLIMIT_MODERATE,
    memLimit: sumo.crypto_pwhash_MEMLIMIT_MODERATE,
    salt: u8ToBase64(salt),
    nonce: u8ToBase64(nonce),
    ciphertext: u8ToBase64(ct),
  }
  return JSON.stringify(file, null, 2) + '\n'
}

/** Parse the outer backup file (no decryption). Throws BackupError. */
function parseBackupFile(text: string): BackupFileV1 {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new BackupError('That file is not a Longtable backup — it is not valid JSON.')
  }
  if (!isRecord(parsed)) {
    throw new BackupError('That file is not a Longtable backup (expected a JSON object).')
  }
  if (parsed.format !== BACKUP_FORMAT || parsed.version !== BACKUP_VERSION) {
    throw new BackupError(
      `That file is not a ${BACKUP_FORMAT} v${BACKUP_VERSION} backup ` +
        `(found format ${String(parsed.format)} v${String(parsed.version)}).`,
    )
  }
  if (parsed.kdf !== BACKUP_KDF) {
    throw new BackupError(
      `That backup uses key derivation "${String(parsed.kdf)}", which this app cannot open.`,
    )
  }
  const opsLimit = parsed.opsLimit
  const memLimit = parsed.memLimit
  if (
    typeof opsLimit !== 'number' ||
    !Number.isInteger(opsLimit) ||
    opsLimit < BACKUP_KDF_OPS_MIN ||
    opsLimit > BACKUP_KDF_OPS_MAX ||
    typeof memLimit !== 'number' ||
    !Number.isInteger(memLimit) ||
    memLimit < BACKUP_KDF_MEM_MIN ||
    memLimit > BACKUP_KDF_MEM_MAX
  ) {
    throw new BackupError('That backup file is damaged: its key-derivation settings are out of range.')
  }
  return parsed as unknown as BackupFileV1
}

/**
 * Decrypt a backup file. A wrong passphrase and a corrupt file both fail
 * the secretbox MAC and get the SAME message — they are indistinguishable
 * by construction, and no partial plaintext ever exists to import.
 * Does NOT fully validate the payload; restoreBackup does that before
 * writing anything.
 */
export async function decryptBackupFile(
  fileText: string,
  passphrase: string,
): Promise<BackupPlaintextV1> {
  if (typeof passphrase !== 'string') {
    throw new BackupError(
      'The passphrase was wrong, or the backup file is damaged. ' +
        'Nothing was changed — check the passphrase and try again.',
    )
  }
  const file = parseBackupFile(fileText)
  const sumo = await loadSumo()
  await cryptoReady()
  const salt = b64(file.salt, 'salt')
  const nonce = b64(file.nonce, 'nonce')
  const ct = b64(file.ciphertext, 'ciphertext')
  if (salt.length !== sumo.crypto_pwhash_SALTBYTES) {
    throw new BackupError('That backup file is damaged: its salt has the wrong length.')
  }
  if (nonce.length !== sodium.crypto_secretbox_NONCEBYTES) {
    throw new BackupError('That backup file is damaged: its nonce has the wrong length.')
  }
  const key = sumo.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    sodium.from_string(passphrase),
    salt,
    file.opsLimit,
    file.memLimit,
    sumo.crypto_pwhash_ALG_ARGON2ID13,
  )
  let plainBytes: Uint8Array
  try {
    plainBytes = sodium.crypto_secretbox_open_easy(ct, nonce, key)
  } catch {
    throw new BackupError(
      'The passphrase was wrong, or the backup file is damaged. ' +
        'Nothing was changed — check the passphrase and try again.',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(u8ToUtf8(plainBytes))
  } catch {
    throw new BackupError('That backup file is damaged: its contents do not parse.')
  }
  if (!isRecord(parsed) || parsed.format !== BACKUP_FORMAT || parsed.version !== BACKUP_VERSION) {
    throw new BackupError('That backup file is damaged: its contents are not a Longtable backup.')
  }
  return parsed as unknown as BackupPlaintextV1
}

// ---------------------------------------------------------------------------
// Validation (runs entirely before restore writes anything)
// ---------------------------------------------------------------------------

const HEX64 = /^[0-9a-f]{64}$/

/**
 * Fully validate a decrypted payload: shape, cross-references, the
 * identity DID re-derived from the secret key, recipe contents through
 * the store's own sanitizer, and every shelf update trial-applied to a
 * scratch doc. Throws BackupError on the first problem. Pure w.r.t.
 * local state: reads nothing, writes nothing.
 */
export function validateBackupPlaintext(plain: unknown): BackupPlaintextV1 {
  if (!isRecord(plain)) throw new BackupError('That backup file is damaged: its contents are not an object.')
  if (typeof plain.exportedAt !== 'string' || !plain.exportedAt) {
    throw new BackupError('That backup file is damaged: it has no export date.')
  }
  if (typeof plain.displayName !== 'string') {
    throw new BackupError('That backup file is damaged: the display name is not text.')
  }
  // Identity: the DID must be exactly the one the secret key derives —
  // an Ed25519 secret key is seed(32) || publicKey(32), so the check
  // needs no crypto beyond the did:key encoding.
  if (!isRecord(plain.identity) || !isDid(plain.identity.did)) {
    throw new BackupError('That backup file is damaged: the identity has no valid DID.')
  }
  const secretBytes = b64(plain.identity.secretKey, 'identity secret key')
  if (secretBytes.length !== 64) {
    throw new BackupError('That backup file is damaged: the identity key has the wrong length.')
  }
  if (didFromPublicKey(secretBytes.slice(32)) !== plain.identity.did) {
    throw new BackupError(
      'That backup file is damaged: the identity key does not match its DID. Nothing was changed.',
    )
  }
  if (!Array.isArray(plain.friends)) {
    throw new BackupError('That backup file is damaged: the friends list is missing.')
  }
  const friends: FriendRecord[] = plain.friends.map((raw, i) => {
    const where = `friend ${i + 1}`
    if (!isRecord(raw) || !isDid(raw.did)) {
      throw new BackupError(`That backup file is damaged: ${where} has no valid DID.`)
    }
    if (typeof raw.name !== 'string') {
      throw new BackupError(`That backup file is damaged: ${where} has no name.`)
    }
    const pairSecret = b64(raw.pairSecret, `${where} pair secret`)
    if (pairSecret.length !== 32) {
      throw new BackupError(`That backup file is damaged: ${where} pair secret has the wrong length.`)
    }
    if (typeof raw.pairId !== 'string' || !HEX64.test(raw.pairId)) {
      throw new BackupError(`That backup file is damaged: ${where} pair id is malformed.`)
    }
    if (typeof raw.signaling !== 'string' || !raw.signaling) {
      throw new BackupError(`That backup file is damaged: ${where} has no signaling server.`)
    }
    if (typeof raw.addedAt !== 'string' || !raw.addedAt) {
      throw new BackupError(`That backup file is damaged: ${where} has no added date.`)
    }
    if (raw.channelTag !== undefined && typeof raw.channelTag !== 'string') {
      throw new BackupError(`That backup file is damaged: ${where} channel tag is malformed.`)
    }
    return raw as unknown as FriendRecord
  })
  const friendByDid = new Map(friends.map((f) => [f.did, f]))
  if (!isRecord(plain.vault)) {
    throw new BackupError('That backup file is damaged: the key vault is missing.')
  }
  for (const [recipeId, rec] of Object.entries(plain.vault)) {
    if (!isRecord(rec)) {
      throw new BackupError('That backup file is damaged: a key-vault entry is not an object.')
    }
    if (typeof rec.keyId !== 'string' || !rec.keyId) {
      throw new BackupError(`That backup file is damaged: the vault key for ${recipeId} has no key id.`)
    }
    const keyBytes = b64(rec.key, `vault key for ${recipeId}`)
    if (keyBytes.length !== 32) {
      throw new BackupError(`That backup file is damaged: the vault key for ${recipeId} has the wrong length.`)
    }
    if (typeof rec.version !== 'number' || !Number.isInteger(rec.version) || rec.version < 1) {
      throw new BackupError(`That backup file is damaged: the vault key for ${recipeId} has a bad version.`)
    }
    if (!isStringArray(rec.friends) || !rec.friends.every(isDid)) {
      throw new BackupError(`That backup file is damaged: the vault key for ${recipeId} lists a bad friend.`)
    }
  }
  if (!Array.isArray(plain.shares)) {
    throw new BackupError('That backup file is damaged: the shares list is missing.')
  }
  const shares: ShareRecord[] = plain.shares.map((raw, i) => {
    const where = `share ${i + 1}`
    if (!isRecord(raw) || typeof raw.recipeId !== 'string' || !raw.recipeId) {
      throw new BackupError(`That backup file is damaged: ${where} has no recipe id.`)
    }
    if (typeof raw.room !== 'string' || raw.room !== roomForRecipe(raw.recipeId)) {
      throw new BackupError(`That backup file is damaged: ${where} has a room that does not match its recipe.`)
    }
    if (typeof raw.signaling !== 'string' || !raw.signaling) {
      throw new BackupError(`That backup file is damaged: ${where} has no signaling server.`)
    }
    if (raw.role !== 'host' && raw.role !== 'guest') {
      throw new BackupError(`That backup file is damaged: ${where} has an unknown role.`)
    }
    if (raw.secret !== undefined) {
      const secret = b64(raw.secret, `${where} room secret`)
      if (secret.length !== 32) {
        throw new BackupError(`That backup file is damaged: ${where} room secret has the wrong length.`)
      }
    }
    return raw as unknown as ShareRecord
  })
  if (!isRecord(plain.received)) {
    throw new BackupError('That backup file is damaged: the received-shares mapping is missing.')
  }
  for (const [key, m] of Object.entries(plain.received)) {
    if (!key.includes(':') || !isRecord(m) || typeof m.localId !== 'string' || !m.localId) {
      throw new BackupError('That backup file is damaged: a received-share entry is malformed.')
    }
    if (typeof m.updatedAt !== 'string' || !m.updatedAt) {
      throw new BackupError('That backup file is damaged: a received-share entry has no date.')
    }
  }
  if (!Array.isArray(plain.recipes)) {
    throw new BackupError('That backup file is damaged: the recipes list is missing.')
  }
  const seenIds = new Set<string>()
  const recipes: BackupRecipe[] = plain.recipes.map((raw, i) => {
    const where = `recipe ${i + 1}`
    if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id) {
      throw new BackupError(`That backup file is damaged: ${where} has no id.`)
    }
    if (seenIds.has(raw.id)) {
      throw new BackupError(`That backup file is damaged: recipe id ${raw.id} appears twice.`)
    }
    seenIds.add(raw.id)
    if (typeof raw.createdAt !== 'string' || !raw.createdAt || typeof raw.updatedAt !== 'string' || !raw.updatedAt) {
      throw new BackupError(`That backup file is damaged: ${where} is missing timestamps.`)
    }
    if (raw.visibility !== undefined && raw.visibility !== 'private' && raw.visibility !== 'friends-only' && raw.visibility !== 'public') {
      throw new BackupError(`That backup file is damaged: ${where} has an unknown visibility.`)
    }
    // Shape first (explicit, so a malformed recipe fails here instead of
    // being silently coerced), then the store's own sanitizer as the
    // authority on the title: a title that is not text throws here,
    // before anything is written.
    if (typeof raw.title !== 'string' || !raw.title.trim()) {
      throw new BackupError(`That backup file is damaged: ${where} failed validation.`)
    }
    if (!isStringArray(raw.ingredients) || !isStringArray(raw.steps)) {
      throw new BackupError(`That backup file is damaged: ${where} failed validation.`)
    }
    if (raw.photos !== undefined && !isStringArray(raw.photos)) {
      throw new BackupError(`That backup file is damaged: ${where} failed validation.`)
    }
    for (const key of ['prepMinutes', 'cookMinutes'] as const) {
      const v = raw[key]
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
        throw new BackupError(`That backup file is damaged: ${where} failed validation.`)
      }
    }
    try {
      sanitizeRecipeInput(raw as unknown as RecipeInput)
    } catch {
      throw new BackupError(`That backup file is damaged: ${where} failed validation.`)
    }
    return raw as unknown as BackupRecipe
  })
  if (!Array.isArray(plain.shelves)) {
    throw new BackupError('That backup file is damaged: the shelf-doc list is missing.')
  }
  const shelves: BackupShelf[] = plain.shelves.map((raw, i) => {
    const where = `shelf ${i + 1}`
    if (!isRecord(raw) || typeof raw.friendDid !== 'string' || !friendByDid.has(raw.friendDid)) {
      throw new BackupError(`That backup file is damaged: ${where} names an unknown friend.`)
    }
    const friend = friendByDid.get(raw.friendDid)!
    if (typeof raw.guid !== 'string' || raw.guid !== shelfGuidFor(friend)) {
      throw new BackupError(`That backup file is damaged: ${where} has a guid that does not match its friend.`)
    }
    const bytes = b64(raw.update, `${where} update`)
    if (bytes.length === 0) {
      throw new BackupError(`That backup file is damaged: ${where} update is empty.`)
    }
    // Trial-apply to a scratch doc: a malformed Yjs update must fail
    // here, during validation — never halfway through the write phase.
    const scratch = new Y.Doc()
    try {
      Y.applyUpdate(scratch, bytes)
    } catch {
      throw new BackupError(`That backup file is damaged: ${where} update does not apply.`)
    } finally {
      scratch.destroy()
    }
    return raw as unknown as BackupShelf
  })
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: plain.exportedAt,
    displayName: plain.displayName,
    identity: plain.identity as BackupPlaintextV1['identity'],
    friends,
    vault: plain.vault as KeyVault,
    shares,
    received: plain.received as BackupPlaintextV1['received'],
    recipes,
    shelves,
  }
}

// ---------------------------------------------------------------------------
// Collection (reads only, through existing accessors)
// ---------------------------------------------------------------------------

/** Gather the whole restorable state. Reads only; touches nothing. */
export async function collectBackup(
  repo: YjsStore,
  kv: KeyValueStore,
  identity: Identity,
): Promise<BackupPlaintextV1> {
  const index = await getOrCreateIndex(repo, kv)
  const summaries = await listRecipes(index)
  const recipes: BackupRecipe[] = []
  for (const s of summaries) {
    const recipe = await getRecipe(repo, s.url)
    if (recipe) recipes.push({ id: s.id, ...recipe })
  }
  const friends = listFriends(kv)
  const shelves: BackupShelf[] = []
  for (const friend of friends) {
    // Read the shelf doc directly by guid — no channel join, no network.
    const guid = shelfGuidFor(friend)
    const doc = await getOrCreateDoc(repo, guid)
    shelves.push({ friendDid: friend.did, guid, update: u8ToBase64(Y.encodeStateAsUpdate(doc)) })
  }
  const vault = loadVault(kv)
  const shares = listShares(kv)
  const received = loadReceivedMap(kv)
  // Fail closed (H9): a backup snapshots the state a restore will
  // REPLACE the device with. If any source store is damaged, the
  // reads above returned safe empty views — backing those up would
  // mint a backup that deletes the user's friends / keys / shares on
  // restore. Refuse instead, and say which store is damaged; the user
  // restores from an older backup (or re-pairs) first. The loads above
  // are what detect the damage, so the registry is accurate here.
  const damaged = [FRIENDS_KEY, VAULT_KEY, SHARES_KEY, RECEIVED_KEY].filter(
    isStoreCorrupt,
  )
  if (damaged.length > 0) {
    throw new BackupError(
      `Cannot make a backup right now: the saved ${damaged.map(corruptStoreLabel).join(', ')} ` +
        `could not be read — ${damaged.length === 1 ? 'it looks' : 'they look'} damaged. ` +
        'A backup made now would be missing that data, so nothing was written. ' +
        'Restore from an older backup first.',
    )
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    displayName: getDisplayName(kv),
    identity: { did: identity.did, secretKey: u8ToBase64(identity.secretKey) },
    friends,
    vault,
    shares,
    received,
    recipes,
    shelves,
  }
}

/** Suggested filename for a backup download/share. */
export function backupFileName(exportedAt: string = new Date().toISOString()): string {
  return `longtable-backup-${exportedAt.slice(0, 10)}.ltbackup`
}

// ---------------------------------------------------------------------------
// Restore (validate everything, then replace local state)
// ---------------------------------------------------------------------------

/** Wipe one Yjs doc's persisted state (mirrors deleteRecipe's pattern). */
async function wipeDoc(repo: YjsStore, guid: string): Promise<void> {
  await getOrCreateDoc(repo, guid)
  const cached = repo.docs.get(guid)
  repo.docs.delete(guid)
  repo.pending.delete(guid)
  // L-N3: an in-memory (degraded) doc has no persistence to clear;
  // dropping it from the cache is the whole wipe.
  if (cached?.persistence) {
    await cached.persistence.clearData()
  }
}

/**
 * Restore a backup file, replacing ALL local state. The caller (UI) owns
 * the confirmation — this function replaces unconditionally once called.
 * Throws BackupError (nothing partially imported) on any failure; the
 * throw happens before the wipe whenever validation can catch it.
 */
export async function restoreBackup(
  repo: YjsStore,
  kv: KeyValueStore,
  fileText: string,
  passphrase: string,
): Promise<RestoreReport> {
  const plain = validateBackupPlaintext(await decryptBackupFile(fileText, passphrase))

  // Snapshot what must be wiped: current recipes + shelf docs for the
  // union of current and backed-up friends.
  const index = await getOrCreateIndex(repo, kv)
  const currentRecipes = await listRecipes(index)
  const currentFriends = listFriends(kv)
  const shelfGuids = new Set<string>()
  for (const f of [...currentFriends, ...plain.friends]) shelfGuids.add(shelfGuidFor(f))

  // Tear down live sync providers first: they hold the very docs about
  // to be wiped, and the app reloads after restore anyway.
  disconnectAllFriendChannels()
  destroyAllShareProviders()

  // --- wipe phase ---
  for (const s of currentRecipes) {
    await deleteRecipe(repo, index, s.id)
  }
  for (const guid of shelfGuids) {
    await wipeDoc(repo, guid)
  }

  // --- write phase (validation already passed; these cannot fail on content) ---
  // H9: restore is the deliberate replacement path — the one writer
  // allowed to overwrite a corrupt store. Clear the corruption
  // records for the stores about to be replaced FIRST, so the save
  // functions below do not refuse; the quarantine copies already
  // preserve the damaged bytes.
  clearCorruptStore(FRIENDS_KEY)
  clearCorruptStore(VAULT_KEY)
  clearCorruptStore(SHARES_KEY)
  clearCorruptStore(RECEIVED_KEY)
  const restoredDid = await restoreIdentitySecret(plain.identity.secretKey, kv)
  if (restoredDid !== plain.identity.did) {
    throw new BackupError('Restore failed: the restored identity does not match the backup.')
  }
  setDisplayName(plain.displayName, kv)
  for (const f of currentFriends) removeFriend(f.did, kv)
  // Replace the friend list in one write (not one saveFriend per
  // friend): saveFriend re-loads first, and a still-damaged stored
  // list would re-register the corruption and refuse — the whole-list
  // write is the restore primitive for exactly that case.
  saveFriendsList(plain.friends, kv)
  saveVault(plain.vault, kv)

  const recipeIds = new Set(plain.recipes.map((r) => r.id))
  const keptShares = plain.shares.filter((s) => recipeIds.has(s.recipeId))
  saveShares(kv, keptShares)
  const keptReceived: BackupPlaintextV1['received'] = {}
  let droppedReceived = 0
  for (const [key, m] of Object.entries(plain.received)) {
    if (recipeIds.has(m.localId)) keptReceived[key] = m
    else droppedReceived++
  }
  saveReceivedMap(kv, keptReceived)

  const freshIndex = await getOrCreateIndex(repo, kv)
  for (const r of plain.recipes) {
    await restoreRecipe(repo, freshIndex, r.id, r)
  }
  for (const shelf of plain.shelves) {
    const doc = await getOrCreateDoc(repo, shelf.guid)
    Y.applyUpdate(doc, base64ToU8(shelf.update))
  }
  await repo.flush()

  return {
    did: plain.identity.did,
    exportedAt: plain.exportedAt,
    recipes: plain.recipes.length,
    friends: plain.friends.length,
    shares: keptShares.length,
    vaultEntries: Object.keys(loadVault(kv)).length,
    shelves: plain.shelves.length,
    droppedShares: plain.shares.length - keptShares.length,
    droppedReceived,
  }
}
