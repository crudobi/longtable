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
  type FriendRecord,
} from './friends'
import {
  dropRecipeKey,
  ensureRecipeKey,
  getRecipeKey,
  loadVault,
  processChannel,
  publishShare,
  rotateRecipeKey,
  setKeyFriends,
  unpublishShare,
  type ReceivedShare,
} from './shelf'
import { getRepo, type YjsStore } from '../store/repo'
import {
  createRecipe,
  getOrCreateIndex,
  getRecipe,
  updateRecipe,
  type IndexHandle,
} from '../store/recipes'

const NAME_KEY = 'longtable:display-name'
const RECEIVED_KEY = 'longtable:received-shares'

export function getDisplayName(kv: KeyValueStore = localStorage): string {
  return kv.getItem(NAME_KEY) ?? ''
}

export function setDisplayName(name: string, kv: KeyValueStore = localStorage): void {
  kv.setItem(NAME_KEY, name)
}

// ---------------------------------------------------------------------------
// Sharing (owner side)
// ---------------------------------------------------------------------------

/**
 * Share `recipeId` with exactly `friendDids` (the full authorized set).
 * If the set shrank since last time, the key rotates BEFORE publishing, so
 * a removed friend's envelope can never open the new payloads.
 */
export async function shareRecipeWithFriends(
  recipeId: string,
  friendDids: string[],
  identity: Identity,
  kv: KeyValueStore = localStorage,
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
    keyRec = await rotateRecipeKey(recipeId, friendDids, kv)
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
  for (const did of friendDids) {
    const friend = getFriend(did, kv)
    if (!friend) continue
    const doc = await getChannelDoc(friend, repo)
    await publishShare(doc, identity, myName, fresh, recipeId, keyRec, did)
  }
}

/** Republish a friends-only recipe after a local edit (no set change). */
export async function republishIfShared(
  recipeId: string,
  identity: Identity,
  kv: KeyValueStore = localStorage,
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
  for (const did of keyRec.friends) {
    const friend = getFriend(did, kv)
    if (!friend) continue
    const doc = await getChannelDoc(friend, repo)
    await publishShare(doc, identity, myName, recipe, recipeId, keyRec, did)
  }
}

/** Stop sharing a recipe everywhere (delete path): strip all channels. */
export async function unshareRecipeEverywhere(
  recipeId: string,
  identity: Identity,
  kv: KeyValueStore = localStorage,
  repo: YjsStore = getRepo(),
): Promise<void> {
  const keyRec = getRecipeKey(recipeId, kv)
  if (!keyRec) return
  const myName = getDisplayName(kv)
  for (const did of keyRec.friends) {
    const friend = getFriend(did, kv)
    if (!friend) continue
    const doc = await getChannelDoc(friend, repo)
    await unpublishShare(doc, identity, myName, recipeId, did)
  }
  dropRecipeKey(recipeId, kv)
}

// ---------------------------------------------------------------------------
// Unfriend + re-key
// ---------------------------------------------------------------------------

/**
 * Remove a friend entirely: rotate every recipe key they held and
 * republish those recipes to their remaining authorized friends, clear my
 * payloads from the ex-friend's channel, then drop the friend + channel.
 * The ex-friend keeps old versions they already decrypted; every future
 * version is sealed under keys they never receive.
 */
export async function unfriendAndRekey(
  friendDid: string,
  identity: Identity,
  kv: KeyValueStore = localStorage,
  repo: YjsStore = getRepo(),
): Promise<void> {
  const ex = getFriend(friendDid, kv)
  if (!ex) return
  const index = await getOrCreateIndex(repo)
  const snap = await index.doc()
  const myName = getDisplayName(kv)

  // Every recipe whose key this friend held.
  const vault = loadVault(kv)
  const affected = Object.entries(vault)
    .filter(([, rec]) => rec.friends.includes(friendDid))
    .map(([recipeId]) => recipeId)

  // Clear my side of the ex-friend's channel (payloads + manifest refs).
  const exDoc = await getChannelDoc(ex, repo)
  for (const recipeId of affected) {
    await unpublishShare(exDoc, identity, myName, recipeId, friendDid)
  }

  // Rotate + republish each affected recipe to its remaining friends.
  for (const recipeId of affected) {
    const entry = snap?.recipes[recipeId]
    if (!entry) continue
    const recipe = await getRecipe(repo, entry.url)
    if (!recipe) continue
    const remaining = (getRecipeKey(recipeId, kv)?.friends ?? []).filter(
      (d) => d !== friendDid,
    )
    const keyRec = await rotateRecipeKey(recipeId, remaining, kv)
    for (const did of remaining) {
      const friend = getFriend(did, kv)
      if (!friend) continue
      const doc = await getChannelDoc(friend, repo)
      await publishShare(doc, identity, myName, recipe, recipeId, keyRec, did)
    }
  }

  removeFriend(friendDid, kv)
  disconnectFriendChannel(friendDid)
}

// ---------------------------------------------------------------------------
// Receiving (friend side)
// ---------------------------------------------------------------------------

interface ReceivedMapping {
  localId: string
  updatedAt: string
}

function loadReceived(kv: KeyValueStore): Record<string, ReceivedMapping> {
  try {
    const raw = kv.getItem(RECEIVED_KEY)
    if (!raw) return {}
    const obj: unknown = JSON.parse(raw)
    return typeof obj === 'object' && obj !== null
      ? (obj as Record<string, ReceivedMapping>)
      : {}
  } catch {
    return {}
  }
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
  kv: KeyValueStore = localStorage,
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
  kv: KeyValueStore = localStorage,
  repo: YjsStore = getRepo(),
  onFailure?: (f: { shareId: string; reason: string }) => void,
): Promise<number> {
  const index = await getOrCreateIndex(repo)
  const mapping = loadReceived(kv)
  let count = 0
  for (const friend of listFriends(kv)) {
    const doc = await getChannelDoc(friend, repo)
    const { received, failures } = await processChannel(doc, identity)
    for (const f of failures) onFailure?.(f)
    for (const share of received) {
      await upsertReceived(index, share, mapping, repo)
      count++
    }
  }
  kv.setItem(RECEIVED_KEY, JSON.stringify(mapping))
  return count
}

async function upsertReceived(
  index: IndexHandle,
  share: ReceivedShare,
  mapping: Record<string, ReceivedMapping>,
  repo: YjsStore,
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
    mapping[key] = { localId: summary.id, updatedAt: share.updatedAt }
    return
  }
  if (existing.updatedAt === share.updatedAt) return // already current
  await updateRecipe(repo, index, existing.localId, input)
  existing.updatedAt = share.updatedAt
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
  kv: KeyValueStore = localStorage,
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
