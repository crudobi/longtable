/**
 * Friends service — app-level orchestration for Phase 2.
 *
 * Wires identity + friend channels + shelf crypto to the recipe store:
 *
 *   - shareRecipeWithFriends: marks a recipe friends-only, ensures/rotates
 *     its key, and publishes encrypted payloads + sealed envelopes into
 *     each authorized friend's channel. De-authorizing a friend rotates the
 *     key first, so their old envelope can never open a new payload.
 *   - importReceivedShares: processes every friend channel, decrypts what
 *     is addressed to me, and upserts local copies (tracked in a mapping
 *     so owner updates land on the same local recipe).
 *   - unfriendAndRekey: removes the friend, rotates every key they held,
 *     republishes to remaining friends, tears the channel down.
 *
 * Also installs the `window.__ltFriends` debug hooks the e2e proof uses to
 * capture shelf bytes ("network traffic") and attempt decryption as a
 * stranger — the explicit decrypt-failure evidence for the Phase 2 oath.
 */
import * as Y from 'yjs'
import type { Identity, KeyValueStore } from '../identity/identity'
import { base64ToU8, u8ToBase64 } from '../identity/codec'
import {
  disconnectFriendChannel,
  getChannelDoc,
  getFriend,
  listFriends,
  removeFriend,
  shelfGuidFor,
  type FriendRecord,
} from './friends'
import { secretKv } from '../secrets/secretStore'
import {
  assertStoreWritable,
  isStoreCorrupt,
  noteCorruptStore,
  readStoredJson,
} from '../store/corrupt'
import {
  dropRecipeKey,
  ensureRecipeKey,
  getRecipeKey,
  loadVault,
  newRecipeKeyRecord,
  processChannel,
  publishShare,
  readEnvelope,
  readManifestEntry,
  readPayload,
  saveRecipeKeyRecord,
  setKeyFriends,
  shelfShareIsCurrent,
  unpublishShare,
  type ReceivedShare,
  type RecipeKeyRecord,
  type ShelfTombstone,
} from './shelf'
import {
  getRecipeProvenance,
  recordReceivedProvenance,
} from './provenance'
import { getOrCreateDoc, getRepo, type YjsStore } from '../store/repo'
import type { Recipe } from '../types'
import {
  createRecipe,
  deleteRecipe,
  getOrCreateIndex,
  getRecipe,
  updateRecipe,
  type IndexHandle,
} from '../store/recipes'

const NAME_KEY = 'longtable:display-name'
export const RECEIVED_KEY = 'longtable:received-shares'

export function getDisplayName(kv: KeyValueStore = secretKv): string {
  return kv.getItem(NAME_KEY) ?? ''
}

export function setDisplayName(name: string, kv: KeyValueStore = secretKv): void {
  kv.setItem(NAME_KEY, name)
}

// ---------------------------------------------------------------------------
// Sharing (owner side)
// ---------------------------------------------------------------------------

/**
 * Share `recipeId` with exactly `friendDids` (the full authorized set).
 * If the set shrank since last time, the key rotates BEFORE publishing, so
 * a removed friend's envelope can never open the new payloads.
 *
 * Per-friend isolation (M1-rel): each friend's publish is independent —
 * one friend's channel failing no longer aborts the rest (the old loop
 * threw on the first failure and left the remaining friends stale with
 * no retry). Failures are collected and thrown as one aggregated error
 * after every friend was attempted; the startup sweep repairs any
 * friend left stale.
 */
export async function shareRecipeWithFriends(
  recipeId: string,
  friendDids: string[],
  identity: Identity,
  kv: KeyValueStore = secretKv,
  repo: YjsStore = getRepo(),
): Promise<void> {
  const index = await getOrCreateIndex(repo)
  const snap = await index.doc()
  const entry = snap?.recipes[recipeId]
  if (!entry) throw new Error(`recipe not found: ${recipeId}`)

  const prev = getRecipeKey(recipeId, kv)
  const removed = (prev?.friends ?? []).filter((d) => !friendDids.includes(d))
  let keyRec = prev ?? (await ensureRecipeKey(recipeId, kv))
  if (removed.length > 0) {
    // Someone lost access: strip their channel copies, then rotate so
    // their old key/envelope are useless for anything published later.
    for (const did of removed) {
      const ex = getFriend(did, kv)
      if (ex) {
        const doc = await getChannelDoc(ex, repo)
        await unpublishShare(doc, identity, getDisplayName(kv), recipeId, did)
      }
    }
  } else {
    setKeyFriends(recipeId, friendDids, kv)
    keyRec = { ...keyRec, friends: [...friendDids] }
  }

  // Mark the recipe friends-only in its own document, then publish the
  // fresh snapshot (with the new visibility) to each authorized friend.
  await updateRecipe(repo, index, recipeId, {
    visibility: friendDids.length > 0 ? 'friends-only' : 'private',
  })
  const fresh = await getRecipe(repo, entry.url)
  if (!fresh) throw new Error(`recipe vanished: ${recipeId}`)

  const myName = getDisplayName(kv)
  if (removed.length > 0) {
    // Rotate-before-republish, atomically (M7): the new key is only
    // committed once every remaining friend holds the new payload.
    await rotateAndRepublishRecipe(
      recipeId,
      friendDids,
      fresh,
      identity,
      kv,
      repo,
    )
  } else {
    const failures: string[] = []
    for (const did of friendDids) {
      try {
        const friend = getFriend(did, kv)
        if (!friend) {
          failures.push(`${did}: no friend record`)
          continue
        }
        const doc = await getChannelDoc(friend, repo)
        await publishShare(doc, identity, myName, fresh, recipeId, keyRec, did)
      } catch (e) {
        failures.push(`${did}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `Could not share with ${failures.length} friend${failures.length === 1 ? '' : 's'}: ${failures.join('; ')}`,
      )
    }
  }

  // M7 shrink path: a de-authorized friend who now holds NO shared
  // recipe keeps a live connection to the shelf channel otherwise.
  // Disconnecting per recipe would break their OTHER shared recipes
  // (one channel per pair carries every recipe), so the channel is
  // only torn down when the friend has nothing left in the vault.
  for (const did of removed) {
    const stillHolds = Object.values(loadVault(kv)).some((rec) =>
      rec.friends.includes(did),
    )
    if (!stillHolds) disconnectFriendChannel(did)
  }
}

/**
 * Rotate a recipe's key and republish to `remainingDids`, atomically
 * (M7): the candidate key is published to every remaining friend
 * FIRST and only committed to the vault once all of them hold it. A
 * failure anywhere leaves the vault on the old key — whose payloads
 * are still valid — and rolls the friends who already got the new
 * payload back to the old one, so no friend is left holding an
 * envelope for a key the owner does not have. Throws an aggregated
 * error listing the friends that could not be reached.
 */
export async function rotateAndRepublishRecipe(
  recipeId: string,
  remainingDids: string[],
  recipe: Recipe,
  identity: Identity,
  kv: KeyValueStore = secretKv,
  repo: YjsStore = getRepo(),
): Promise<RecipeKeyRecord> {
  const prev = getRecipeKey(recipeId, kv)
  const candidate = await newRecipeKeyRecord(prev, remainingDids)
  const myName = getDisplayName(kv)
  const succeeded: string[] = []
  const failures: string[] = []
  for (const did of remainingDids) {
    try {
      const friend = getFriend(did, kv)
      if (!friend) {
        failures.push(`${did}: no friend record`)
        continue
      }
      const doc = await getChannelDoc(friend, repo)
      await publishShare(doc, identity, myName, recipe, recipeId, candidate, did)
      succeeded.push(did)
    } catch (e) {
      failures.push(`${did}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (failures.length > 0) {
    // Roll back the friends who already got the new payload, best
    // effort, so the shelf converges back onto the committed key.
    if (prev) {
      for (const did of succeeded) {
        try {
          const friend = getFriend(did, kv)
          if (!friend) continue
          const doc = await getChannelDoc(friend, repo)
          await publishShare(doc, identity, myName, recipe, recipeId, prev, did)
        } catch {
          /* rollback is best-effort; the sweep repairs what is left */
        }
      }
    }
    throw new Error(
      `Could not re-key for ${failures.length} friend${failures.length === 1 ? '' : 's'}: ${failures.join('; ')}`,
    )
  }
  await saveRecipeKeyRecord(recipeId, candidate, kv)
  return candidate
}

/** Republish a friends-only recipe after a local edit (no set change). */
export async function republishIfShared(
  recipeId: string,
  identity: Identity,
  kv: KeyValueStore = secretKv,
  repo: YjsStore = getRepo(),
): Promise<void> {
  const keyRec = getRecipeKey(recipeId, kv)
  if (!keyRec || keyRec.friends.length === 0) return
  const index = await getOrCreateIndex(repo)
  const snap = await index.doc()
  const entry = snap?.recipes[recipeId]
  if (!entry) return
  const recipe = await getRecipe(repo, entry.url)
  if (!recipe) return
  const myName = getDisplayName(kv)
  const failures: string[] = []
  for (const did of keyRec.friends) {
    try {
      const friend = getFriend(did, kv)
      if (!friend) {
        failures.push(`${did}: no friend record`)
        continue
      }
      const doc = await getChannelDoc(friend, repo)
      await publishShare(doc, identity, myName, recipe, recipeId, keyRec, did)
    } catch (e) {
      failures.push(`${did}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `Could not republish to ${failures.length} friend${failures.length === 1 ? '' : 's'}: ${failures.join('; ')}`,
    )
  }
}

/**
 * Stop sharing a recipe everywhere (delete path): strip all channels.
 * Returns the DIDs the recipe was unshared from — the delete flow
 * reports them (H13): those friends' copies are recalled by tombstone
 * when they next sync, not instantly.
 */
export async function unshareRecipeEverywhere(
  recipeId: string,
  identity: Identity,
  kv: KeyValueStore = secretKv,
  repo: YjsStore = getRepo(),
): Promise<string[]> {
  const keyRec = getRecipeKey(recipeId, kv)
  if (!keyRec) return []
  const myName = getDisplayName(kv)
  const sharedWith: string[] = []
  const failures: string[] = []
  for (const did of keyRec.friends) {
    try {
      const friend = getFriend(did, kv)
      if (!friend) continue
      const doc = await getChannelDoc(friend, repo)
      await unpublishShare(doc, identity, myName, recipeId, did)
      sharedWith.push(did)
    } catch (e) {
      failures.push(`${did}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  dropRecipeKey(recipeId, kv)
  if (failures.length > 0) {
    throw new Error(
      `Could not strip the share from ${failures.length} friend${failures.length === 1 ? '' : 's'}: ${failures.join('; ')}`,
    )
  }
  return sharedWith
}

// ---------------------------------------------------------------------------
// Unfriend + re-key (atomic + resumable, M-N4)
// ---------------------------------------------------------------------------

/**
 * A revocation that has not finished yet, persisted so a crash or a
 * failed publish mid-unfriend cannot strand the ex-friend connected
 * with live keys. The friend-record snapshot keeps the channel
 * derivation (shelf guid / room) available after the friend record
 * itself is removed, so a later launch can finish the job.
 */
export interface PendingRevocation {
  friendDid: string
  friend: FriendRecord
  recipeIds: string[]
  completedRecipeIds: string[]
  createdAt: string
  lastAttemptAt: string
  failures: Record<string, string>
}

const PENDING_REVOCATIONS_KEY = 'longtable:pending-revocations:v1'

export function loadPendingRevocations(
  kv: KeyValueStore = secretKv,
): PendingRevocation[] {
  try {
    const raw = kv.getItem(PENDING_REVOCATIONS_KEY)
    if (!raw) return []
    const arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return (arr as PendingRevocation[]).filter(
      (p): p is PendingRevocation =>
        typeof p === 'object' &&
        p !== null &&
        typeof (p as PendingRevocation).friendDid === 'string' &&
        typeof (p as PendingRevocation).friend === 'object' &&
        Array.isArray((p as PendingRevocation).recipeIds),
    )
  } catch {
    return []
  }
}

export function savePendingRevocations(
  kv: KeyValueStore,
  pendings: PendingRevocation[],
): void {
  kv.setItem(PENDING_REVOCATIONS_KEY, JSON.stringify(pendings))
}

function upsertPendingRevocation(
  kv: KeyValueStore,
  pending: PendingRevocation,
): void {
  const all = loadPendingRevocations(kv).filter(
    (p) => p.friendDid !== pending.friendDid,
  )
  all.push(pending)
  savePendingRevocations(kv, all)
}

function dropPendingRevocation(kv: KeyValueStore, friendDid: string): void {
  savePendingRevocations(
    kv,
    loadPendingRevocations(kv).filter((p) => p.friendDid !== friendDid),
  )
}

/**
 * Revoke one friend from one recipe: strip my payload from their
 * channel doc, then rotate the key and republish to the remaining
 * friends (M7 atomic rotate). The ex-friend's channel doc is opened
 * WITHOUT joining its provider (getOrCreateDoc, not getChannelDoc) —
 * the channel was disconnected first, and rejoining it here would
 * hand the ex-friend live sync again mid-revocation.
 */
async function revokeFriendFromRecipe(
  recipeId: string,
  exFriend: FriendRecord,
  identity: Identity,
  kv: KeyValueStore,
  repo: YjsStore,
  snap: Awaited<ReturnType<IndexHandle['doc']>>,
): Promise<void> {
  const exDoc = await getOrCreateDoc(repo, shelfGuidFor(exFriend))
  await unpublishShare(exDoc, identity, getDisplayName(kv), recipeId, exFriend.did)
  const entry = snap?.recipes[recipeId]
  if (!entry) return // recipe gone locally: nothing left to republish
  const recipe = await getRecipe(repo, entry.url)
  if (!recipe) return
  const remaining = (getRecipeKey(recipeId, kv)?.friends ?? []).filter(
    (d) => d !== exFriend.did,
  )
  await rotateAndRepublishRecipe(recipeId, remaining, recipe, identity, kv, repo)
}

/**
 * Remove a friend entirely: disconnect their channel FIRST (they stop
 * receiving immediately, even if a rotation below fails), then rotate
 * every recipe key they held and republish those recipes to their
 * remaining authorized friends, clear my payloads from the ex-friend's
 * channel, then drop the friend record.
 *
 * Resumable (M-N4): a pending-revocation record is persisted BEFORE
 * any key is rotated and updated after each recipe, so a throw
 * anywhere leaves a record the startup sweep (resumePendingRevocations)
 * finishes on the next launch. Per-recipe failures are isolated — one
 * unreachable friend's channel no longer aborts the rest — and the
 * function throws an aggregated error listing the unfinished recipes
 * instead of silently leaving the ex-friend connected.
 * The ex-friend keeps old versions they already decrypted; every future
 * version is sealed under keys they never receive.
 */
export async function unfriendAndRekey(
  friendDid: string,
  identity: Identity,
  kv: KeyValueStore = secretKv,
  repo: YjsStore = getRepo(),
): Promise<void> {
  const ex = getFriend(friendDid, kv)
  const existingPending = loadPendingRevocations(kv).find(
    (p) => p.friendDid === friendDid,
  )
  const target = ex ?? existingPending?.friend
  if (!target) return

  // 1. Disconnect FIRST: the ex-friend stops receiving live shelf
  // updates now, whatever happens below.
  disconnectFriendChannel(friendDid)

  // 2. Persist the pending revocation before mutating any key.
  const vault = loadVault(kv)
  const affected = Object.entries(vault)
    .filter(([, rec]) => rec.friends.includes(friendDid))
    .map(([recipeId]) => recipeId)
  const pending: PendingRevocation = {
    friendDid,
    friend: target,
    recipeIds: [...new Set([...(existingPending?.recipeIds ?? []), ...affected])],
    completedRecipeIds: [...(existingPending?.completedRecipeIds ?? [])],
    createdAt: existingPending?.createdAt ?? new Date().toISOString(),
    lastAttemptAt: new Date().toISOString(),
    failures: { ...(existingPending?.failures ?? {}) },
  }
  upsertPendingRevocation(kv, pending)

  // 3. Per-recipe revocation, isolated + persisted as it goes.
  const index = await getOrCreateIndex(repo)
  const snap = await index.doc()
  for (const recipeId of [...pending.recipeIds]) {
    if (pending.completedRecipeIds.includes(recipeId)) continue
    try {
      await revokeFriendFromRecipe(recipeId, target, identity, kv, repo, snap)
      pending.completedRecipeIds.push(recipeId)
      delete pending.failures[recipeId]
    } catch (e) {
      pending.failures[recipeId] =
        e instanceof Error ? e.message : String(e)
    }
    pending.lastAttemptAt = new Date().toISOString()
    upsertPendingRevocation(kv, pending)
  }

  // 4. The friend record goes regardless — the pending snapshot keeps
  // everything a resume needs — and the channel stays disconnected.
  removeFriend(friendDid, kv)
  disconnectFriendChannel(friendDid)

  if (Object.keys(pending.failures).length === 0) {
    dropPendingRevocation(kv, friendDid)
    return
  }
  const names = Object.keys(pending.failures).join(', ')
  throw new Error(
    `Could not finish removing that friend: ${Object.keys(pending.failures).length} recipe(s) still need re-keying (${names}). They will be retried on the next launch.`,
  )
}

/**
 * Finish any pending revocations left by an interrupted unfriend
 * (M-N4): called on startup, before the friends-only sweep. Returns
 * how many revocations finished and how many recipes are still open.
 * Never throws — an unfinished revocation stays pending for the next
 * launch, it never aborts startup.
 */
export async function resumePendingRevocations(
  identity: Identity,
  kv: KeyValueStore = secretKv,
  repo: YjsStore = getRepo(),
): Promise<{ finished: number; stillPending: number }> {
  let finished = 0
  const pendings = loadPendingRevocations(kv)
  for (const pending of pendings) {
    try {
      disconnectFriendChannel(pending.friendDid)
      const index = await getOrCreateIndex(repo)
      const snap = await index.doc()
      for (const recipeId of [...pending.recipeIds]) {
        if (pending.completedRecipeIds.includes(recipeId)) continue
        try {
          await revokeFriendFromRecipe(
            recipeId,
            pending.friend,
            identity,
            kv,
            repo,
            snap,
          )
          pending.completedRecipeIds.push(recipeId)
          delete pending.failures[recipeId]
        } catch (e) {
          pending.failures[recipeId] =
            e instanceof Error ? e.message : String(e)
        }
        pending.lastAttemptAt = new Date().toISOString()
        upsertPendingRevocation(kv, pending)
      }
      removeFriend(pending.friendDid, kv)
      disconnectFriendChannel(pending.friendDid)
      if (Object.keys(pending.failures).length === 0) {
        dropPendingRevocation(kv, pending.friendDid)
        finished++
      }
    } catch {
      /* keep pending — the next launch retries */
    }
  }
  return {
    finished,
    stillPending: loadPendingRevocations(kv).length,
  }
}

/**
 * Startup friends-only sweep (M1-rel): make every friend's shelf hold
 * exactly their own current shares — nothing more, nothing less.
 *
 * For each recipe in the key vault, for each listed friend: if the
 * friend is authorized and the shelf copy is not current (missing
 * payload/envelope/manifest entry, or a stale keyId/hash), republish
 * it. If the friend is NOT authorized (or the recipe is gone locally),
 * strip any shelf copy left behind by a failed unpublish/unfriend.
 * A healthy shelf is read-only: current copies are left untouched,
 * so the sweep is cheap and idempotent. Pending revocations are
 * resumed first, so an interrupted unfriend finishes before the
 * sweep re-checks the shelves.
 */
export async function sweepFriendsOnlyShares(
  identity: Identity,
  kv: KeyValueStore = secretKv,
  repo: YjsStore = getRepo(),
): Promise<{
  republished: number
  removed: number
  revocationsFinished: number
  failures: { shareId: string; reason: string }[]
}> {
  const resume = await resumePendingRevocations(identity, kv, repo)
  const vault = loadVault(kv)
  const index = await getOrCreateIndex(repo)
  const snap = await index.doc()
  const myName = getDisplayName(kv)
  let republished = 0
  let removed = 0
  const failures: { shareId: string; reason: string }[] = []
  for (const [recipeId, keyRec] of Object.entries(vault)) {
    const entry = snap?.recipes[recipeId]
    const recipe = entry ? await getRecipe(repo, entry.url) : null
    for (const friend of listFriends(kv)) {
      try {
        const doc = await getOrCreateDoc(repo, shelfGuidFor(friend))
        if (recipe && keyRec.friends.includes(friend.did)) {
          if (
            !shelfShareIsCurrent(doc, identity.did, recipeId, keyRec.keyId, friend.did)
          ) {
            await publishShare(doc, identity, myName, recipe, recipeId, keyRec, friend.did)
            republished++
          }
        } else {
          const hasCopy =
            readPayload(doc, recipeId) !== null ||
            readEnvelope(doc, recipeId, friend.did) !== null ||
            readManifestEntry(doc, identity.did, recipeId) !== null
          if (hasCopy) {
            await unpublishShare(doc, identity, myName, recipeId, friend.did)
            removed++
          }
        }
      } catch (e) {
        failures.push({
          shareId: recipeId,
          reason: `${friend.did}: ${e instanceof Error ? e.message : String(e)}`,
        })
      }
    }
    if (!recipe) dropRecipeKey(recipeId, kv)
  }
  return { republished, removed, revocationsFinished: resume.finished, failures }
}

// ---------------------------------------------------------------------------
// Receiving (friend side)
// ---------------------------------------------------------------------------

export interface ReceivedMapping {
  localId: string
  updatedAt: string
  /**
   * FNV-1a-64 hex of the received recipe content last applied (L-N1).
   * Absent on mappings written before this field existed; those entries
   * apply once on an equal timestamp and then record the hash, so the
   * fallback only ever fires once per legacy entry.
   */
  contentHash?: string
}

/** One mapping entry is usable only when its required fields check out. */
function isReceivedMapping(o: unknown): o is ReceivedMapping {
  return (
    typeof o === 'object' &&
    o !== null &&
    typeof (o as ReceivedMapping).localId === 'string' &&
    typeof (o as ReceivedMapping).updatedAt === 'string' &&
    ((o as ReceivedMapping).contentHash === undefined ||
      typeof (o as ReceivedMapping).contentHash === 'string')
  )
}

/**
 * Content hash for the staleness fallback (L-N1): FNV-1a-64 over the
 * canonical JSON of the upsert input, the same hash family as the hub
 * migration digests (hubs.ts `legacyMatchHash`) — deterministic, no
 * dependency, and it only ever distinguishes "same content" from
 * "changed content", so a non-cryptographic hash is the right tool.
 */
export function receivedContentHash(input: {
  title: string
  ingredients: string[]
  steps: string[]
  photos: string[]
  prepMinutes?: number
  cookMinutes?: number
}): string {
  let hash = BigInt('0xcbf29ce484222325')
  const bytes = new TextEncoder().encode(JSON.stringify(input))
  for (const b of bytes) {
    hash ^= BigInt(b)
    hash = (hash * BigInt('0x100000001b3')) & BigInt('0xffffffffffffffff')
  }
  return hash.toString(16).padStart(16, '0')
}

/**
 * Read the received-shares mapping (exported for the backup, Wave 3 C3).
 * Absent reads as empty; corrupt JSON — or a top-level value that is
 * not an object — is quarantined (bytes preserved, see
 * src/store/corrupt.ts) and reads as empty. Entries that fail
 * validation are dropped individually: one bad entry never wipes the
 * mapping for the other shares.
 */
export function loadReceivedMap(kv: KeyValueStore): Record<string, ReceivedMapping> {
  const read = readStoredJson(kv, RECEIVED_KEY)
  if (read.status === 'absent') return {}
  if (read.status === 'corrupt') return {}
  const obj = read.value
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    noteCorruptStore(kv, RECEIVED_KEY, read.raw, 'not a JSON object')
    return {}
  }
  const out: Record<string, ReceivedMapping> = {}
  for (const [key, m] of Object.entries(obj as Record<string, unknown>)) {
    if (isReceivedMapping(m)) out[key] = m
  }
  return out
}

/**
 * Replace the received-shares mapping (backup restore). Refuses
 * (throws CorruptStoreError) when the stored mapping is corrupt:
 * overwriting it would drop every received share's local-id link.
 * Backup restore clears the corruption record first — it is the
 * deliberate replacement path.
 */
export function saveReceivedMap(
  kv: KeyValueStore,
  mapping: Record<string, ReceivedMapping>,
): void {
  assertStoreWritable(RECEIVED_KEY)
  kv.setItem(RECEIVED_KEY, JSON.stringify(mapping))
  // H4 backfill: a mapping entry without provenance (imported before
  // provenance existed, or restored from a backup) still marks a
  // received copy — its owner DID is in the mapping key itself.
  for (const [key, m] of Object.entries(mapping)) {
    if (!m || typeof m.localId !== 'string') continue
    if (getRecipeProvenance(m.localId, kv)) continue
    const { ownerDid, recipeId } = parseReceivedKey(key)
    recordReceivedProvenance(
      m.localId,
      {
        ownerDid,
        ownerName: getFriend(ownerDid, kv)?.name ?? '',
        recipeId,
        receivedAt: new Date().toISOString(),
      },
      kv,
    )
  }
}

function loadReceived(kv: KeyValueStore): Record<string, ReceivedMapping> {
  return loadReceivedMap(kv)
}

/** Mapping key: owner DID + ':' + recipeId (recipeId is a colon-free UUID). */
export function receivedKey(ownerDid: string, recipeId: string): string {
  return `${ownerDid}:${recipeId}`
}

function parseReceivedKey(key: string): { ownerDid: string; recipeId: string } {
  const i = key.lastIndexOf(':')
  return { ownerDid: key.slice(0, i), recipeId: key.slice(i + 1) }
}

/** Info about one received share, for the "Shared with me" shelf UI. */
export interface ReceivedShareInfo {
  ownerDid: string
  ownerName: string
  recipeId: string
  localId: string
  title: string
  updatedAt: string
}

export async function listReceivedShares(
  kv: KeyValueStore = secretKv,
  repo: YjsStore = getRepo(),
): Promise<ReceivedShareInfo[]> {
  const mapping = loadReceived(kv)
  const index = await getOrCreateIndex(repo)
  const snap = await index.doc()
  const out: ReceivedShareInfo[] = []
  for (const [key, m] of Object.entries(mapping)) {
    const { ownerDid, recipeId } = parseReceivedKey(key)
    const entry = snap?.recipes[m.localId]
    out.push({
      ownerDid,
      ownerName: getFriend(ownerDid, kv)?.name ?? '',
      recipeId,
      localId: m.localId,
      title: entry?.title ?? '(untitled)',
      updatedAt: m.updatedAt,
    })
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/**
 * Process every friend channel: verify + decrypt what's addressed to me
 * and upsert local copies. Returns how many shares were seen as readable.
 * Failures (shares not addressed to me, bad signatures) are reported via
 * `onFailure` for diagnostics — they never block valid shares.
 */
export async function importReceivedShares(
  identity: Identity,
  kv: KeyValueStore = secretKv,
  repo: YjsStore = getRepo(),
  onFailure?: (f: { shareId: string; reason: string }) => void,
): Promise<number> {
  // The index reads through the caller's kv: the default (localStorage)
  // does not exist in node, and a backup/restore kv is not the app's
  // store — the mapping's kv is the index's kv.
  const index = await getOrCreateIndex(repo, kv)
  const mapping = loadReceived(kv)
  let count = 0
  for (const friend of listFriends(kv)) {
    // Per-friend isolation (S7): a poisoned channel — or a channel that
    // fails to load at all — must not abort the other friends' imports.
    // Failures are reported via onFailure and the loop continues.
    try {
      const doc = await getChannelDoc(friend, repo)
      // M1-sec: this doc is `friend`'s channel — the owner DID is
      // threaded through importChannelDoc so manifests from any other
      // DID in it are rejected, not imported. Tombstones (H6) still
      // apply via importChannelDoc.
      const { imported } = await importChannelDoc(
        doc,
        identity,
        index,
        mapping,
        repo,
        onFailure,
        kv,
        friend.did,
      )
      count += imported
    } catch (e) {
      onFailure?.({
        shareId: `friend:${friend.did}`,
        reason: `channel for ${friend.did} could not be processed: ${
          e instanceof Error ? e.message : String(e)
        }`,
      })
    }
  }
  // Persist the updated mapping — unless the stored mapping is corrupt
  // (H9): the import ran against a safe empty in-memory view, and
  // saving it would persist that emptiness over the damaged bytes.
  // Skipping the save is safe (the mapping is an upsert cache; the
  // next import rebuilds the entries it needs) and the corruption
  // banner surfaces the damage to the user.
  if (isStoreCorrupt(RECEIVED_KEY)) {
    console.warn(
      'import received shares: stored mapping is damaged, not saving it — ' +
        'restore from an encrypted backup to recover it',
    )
  } else {
    saveReceivedMap(kv, mapping)
  }
  return count
}

/**
 * Apply verified delete tombstones (H6): for each tombstone whose recipe
 * I hold as a received copy, delete the local copy and drop its mapping
 * entry. The copy is deleted even if I edited it locally — the owner's
 * delete recalls the copy, edits and all. Returns how many copies were
 * removed. Tombstones for recipes I never received are no-ops.
 */
export async function applyTombstones(
  tombstones: ShelfTombstone[],
  mapping: Record<string, ReceivedMapping>,
  index: IndexHandle,
  repo: YjsStore,
): Promise<number> {
  let removed = 0
  for (const t of tombstones) {
    const key = receivedKey(t.ownerDid, t.recipeId)
    const existing = mapping[key]
    if (!existing) continue
    await deleteRecipe(repo, index, existing.localId)
    delete mapping[key]
    removed++
  }
  return removed
}

/**
 * Import one channel doc: verify + decrypt what's addressed to me, upsert
 * local copies (per-share isolation, S9), then apply that doc's verified
 * delete tombstones (H6). Extracted from importReceivedShares so the
 * doc-level logic is unit-testable without a live channel provider.
 * Tombstones run AFTER this run's shares: a recipe that is live-shared
 * again is never deleted by its (stale) tombstone.
 * When expectedOwnerDid is given, manifests from any other DID are
 * rejected (M1-sec).
 */
export async function importChannelDoc(
  doc: Y.Doc,
  identity: Identity,
  index: IndexHandle,
  mapping: Record<string, ReceivedMapping>,
  repo: YjsStore,
  onFailure?: (f: { shareId: string; reason: string }) => void,
  kv: KeyValueStore = secretKv,
  expectedOwnerDid?: string,
): Promise<{ imported: number; tombstonesApplied: number }> {
  const { received, failures, tombstones } = await processChannel(
    doc,
    identity,
    expectedOwnerDid,
  )
  for (const f of failures) onFailure?.(f)
  let count = 0
  for (const share of received) {
    // Per-share isolation (S9): a share whose decrypted recipe fails
    // validation is skipped and reported, never aborts the import.
    try {
      await upsertReceived(index, share, mapping, repo, kv)
      count++
    } catch (e) {
      onFailure?.({
        shareId: share.shareId,
        reason: `share could not be saved: ${
          e instanceof Error ? e.message : String(e)
        }`,
      })
    }
  }
  const tombstonesApplied = await applyTombstones(tombstones, mapping, index, repo)
  return { imported: count, tombstonesApplied }
}

async function upsertReceived(
  index: IndexHandle,
  share: ReceivedShare,
  mapping: Record<string, ReceivedMapping>,
  repo: YjsStore,
  kv: KeyValueStore,
): Promise<void> {
  const key = receivedKey(share.ownerDid, share.recipeId)
  const existing = mapping[key]
  const input = {
    title: share.recipe.title,
    ingredients: share.recipe.ingredients,
    steps: share.recipe.steps,
    photos: share.recipe.photos,
    prepMinutes: share.recipe.prepMinutes,
    cookMinutes: share.recipe.cookMinutes,
  }
  if (!existing) {
    const summary = await createRecipe(repo, index, input, {
      createdAt: share.recipe.createdAt,
      updatedAt: share.recipe.updatedAt,
    })
    mapping[key] = {
      localId: summary.id,
      updatedAt: share.updatedAt,
      contentHash: receivedContentHash(input),
    }
    // H4: this local copy is received, not owned — record provenance
    // so it can never be re-published public or QR-shared onward.
    recordReceivedProvenance(
      summary.id,
      {
        ownerDid: share.ownerDid,
        ownerName: share.ownerName,
        recipeId: share.recipeId,
        receivedAt: new Date().toISOString(),
      },
      kv,
    )
    return
  }
  // L-N1: staleness is a timestamp ORDER, not an equality check — and
  // the timestamp alone is not enough. An older updatedAt (owner clock
  // skew, restore from backup) must never overwrite a newer local copy;
  // a same-millisecond re-edit must still land, so an equal timestamp
  // falls back to the content hash: identical content is already
  // current, changed content applies. An unparseable timestamp on
  // either side degrades to the content hash alone.
  const hash = receivedContentHash(input)
  const shareTs = Date.parse(share.updatedAt)
  const existingTs = Date.parse(existing.updatedAt)
  if (Number.isFinite(shareTs) && Number.isFinite(existingTs)) {
    if (shareTs < existingTs) return // older — never overwrite newer
    if (shareTs === existingTs && existing.contentHash === hash) return
  } else if (existing.contentHash === hash) {
    return // unparseable timestamp, identical content
  }
  await updateRecipe(repo, index, existing.localId, input)
  existing.updatedAt = share.updatedAt
  existing.contentHash = hash
  // H4 backfill: an older received copy updated here may predate
  // provenance — make sure it is marked before the next import ends.
  if (!getRecipeProvenance(existing.localId, kv)) {
    recordReceivedProvenance(
      existing.localId,
      {
        ownerDid: share.ownerDid,
        ownerName: share.ownerName,
        recipeId: share.recipeId,
        receivedAt: new Date().toISOString(),
      },
      kv,
    )
  }
}

// ---------------------------------------------------------------------------
// Debug hooks (e2e proof): capture shelf bytes, attempt stranger decrypts
// ---------------------------------------------------------------------------

export interface StrangerAttemptReport {
  sharesSeen: number
  decryptedTitles: string[]
  failures: { shareId: string; reason: string }[]
}

/**
 * Install `window.__ltFriends` for the e2e proof scripts:
 *   - myDid(): this device's DID.
 *   - shelfUpdateB64(friendDid): base64 of the full shelf-doc state with
 *     that friend — stands in for "captured network traffic".
 *   - attemptWithShelfBytes(b64): apply captured bytes to a scratch doc
 *     and run the REAL processChannel with THIS device's identity,
 *     reporting what decrypted and what failed (and why).
 */
export function installFriendsDebugHooks(
  identity: Identity,
  kv: KeyValueStore = secretKv,
  repo: YjsStore = getRepo(),
): void {
  const w = window as unknown as { __ltFriends?: unknown }
  w.__ltFriends = {
    async myDid(): Promise<string> {
      return identity.did
    },
    async friends(): Promise<FriendRecord[]> {
      return listFriends(kv)
    },
    async shelfUpdateB64(friendDid: string): Promise<string> {
      const friend = getFriend(friendDid, kv)
      if (!friend) throw new Error(`no such friend: ${friendDid}`)
      const doc = await getChannelDoc(friend, repo)
      return u8ToBase64(Y.encodeStateAsUpdate(doc))
    },
    async attemptWithShelfBytes(b64: string): Promise<StrangerAttemptReport> {
      const scratch = new Y.Doc()
      try {
        Y.applyUpdate(scratch, base64ToU8(b64))
        const { received, failures } = await processChannel(scratch, identity)
        return {
          sharesSeen: received.length + failures.length,
          decryptedTitles: received.map((r) => r.recipe.title),
          failures,
        }
      } finally {
        scratch.destroy()
      }
    },
  }
}
