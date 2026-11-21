/**
 * Re-share provenance (H4).
 *
 * A recipe this device received from a friend is NOT this device's to
 * publish: re-publishing it public would put someone else's
 * friends-only recipe on the world-readable PDS under this device's
 * account, and QR-sharing it would hand out the plaintext to anyone
 * with the code. Provenance is recorded when a received share is first
 * upserted (service.ts) and backfilled from the received-shares
 * mapping for copies imported before this record existed, so a
 * received copy can never lose its provenance by predating it.
 *
 * The gate lives at every wide-exposure exit, not in the UI alone:
 * publishRecipe (public), applyVisibilityFlow (public tier), and
 * shareRecipe (QR plaintext) all refuse a received recipe. There is
 * deliberately no "adopt" or unblock path: the owner can publish their
 * own recipe; a recipient who wants it public asks the owner.
 */
import { secretKv } from '../secrets/secretStore'
import type { KeyValueStore } from '../identity/identity'

const PROVENANCE_KEY = 'longtable:received-provenance:v1'

export interface ReceivedProvenance {
  /** DID of the friend who shared the recipe. */
  ownerDid: string
  /** Display name the owner announced, if known. */
  ownerName: string
  /** The owner's recipe id (their shareId). */
  recipeId: string
  /** ISO timestamp the copy was first received. */
  receivedAt: string
}

export function loadProvenance(
  kv: KeyValueStore = secretKv,
): Record<string, ReceivedProvenance> {
  try {
    const raw = kv.getItem(PROVENANCE_KEY)
    if (!raw) return {}
    const obj: unknown = JSON.parse(raw)
    return typeof obj === 'object' && obj !== null
      ? (obj as Record<string, ReceivedProvenance>)
      : {}
  } catch {
    return {}
  }
}

export function saveProvenance(
  kv: KeyValueStore,
  provenance: Record<string, ReceivedProvenance>,
): void {
  kv.setItem(PROVENANCE_KEY, JSON.stringify(provenance))
}

/** Record provenance for a local copy (no-op when already recorded). */
export function recordReceivedProvenance(
  localId: string,
  prov: ReceivedProvenance,
  kv: KeyValueStore = secretKv,
): void {
  const all = loadProvenance(kv)
  if (all[localId]) return
  all[localId] = prov
  saveProvenance(kv, all)
}

export function getRecipeProvenance(
  localId: string,
  kv: KeyValueStore = secretKv,
): ReceivedProvenance | null {
  return loadProvenance(kv)[localId] ?? null
}

/** True when this local recipe id is a copy received from a friend. */
export function isReceivedRecipe(
  localId: string,
  kv: KeyValueStore = secretKv,
): boolean {
  return getRecipeProvenance(localId, kv) !== null
}

/** Drop provenance for a local id (delete path: the copy is gone). */
export function clearRecipeProvenance(
  localId: string,
  kv: KeyValueStore = secretKv,
): void {
  const all = loadProvenance(kv)
  if (!(localId in all)) return
  delete all[localId]
  saveProvenance(kv, all)
}

/** Plain-language refusal used at every wide-exposure exit (H4). */
export function receivedRecipeRefusal(prov: ReceivedProvenance): string {
  const who = prov.ownerName || 'a friend'
  return (
    `This recipe was shared with you by ${who}, so it is not yours to ` +
    `publish or share onward — only its owner can make it public.`
  )
}
