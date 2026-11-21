/**
 * One-time recovery migration: Phase 0 (Automerge) -> Phase 1 (Yjs).
 *
 * Phase 0 stored recipes as Automerge documents in an IndexedDB database
 * named `longtable`, written by @automerge/automerge-repo's IndexedDB
 * storage adapter: a single object store `documents` whose keys are
 * `[documentId, "snapshot" | "incremental", sha256]` arrays and whose values
 * are `{ key, binary }`. Phase 1 replaced the store with Yjs (per-document
 * databases named `longtable:recipe:<guid>`) WITHOUT migrating the data, so
 * Phase 0 recipes became invisible in the UI — but the old database was
 * never deleted, only orphaned.
 *
 * This module opens the old database directly, reconstructs every Automerge
 * document (snapshot chunks first, then incrementals — the same load order
 * automerge-repo's StorageSubsystem used — fed to `Automerge.loadIncremental`),
 * picks out the documents shaped like recipes (string `title`, string-array
 * `ingredients`/`steps`), and imports them into the Yjs store through the
 * recipes API. The old index document (`{ recipes: {...} }`) fails the shape
 * check and is skipped; scanning every document (rather than trusting the old
 * index pointer, which the new app has overwritten in localStorage) also
 * recovers recipes whose index entries were lost.
 *
 * Guarded by a localStorage flag so it runs once. As a second line of
 * defense it dedupes by content fingerprint (title + ingredients + steps +
 * photos + times), so even if the flag is lost a re-run imports nothing
 * twice. The old database is deliberately left in place as a backup.
 *
 * Why @automerge/automerge still ships (Rel L7, Wave 5A decision —
 * DO NOT drop on a guess): the migration is the only path that can
 * recover a Phase 0 cookbook, and dropping the dependency removes it
 * for every device that has not yet run a clean v2 migration. The
 * code-level evidence is all in place (flag-guarded with a versioned
 * v2 flag that only a zero-failure run sets, fingerprint-deduped, old
 * DB left as backup, corrupt docs retried not dropped), but there is
 * NO device census: nothing in the repo or the ops state proves every
 * Phase 0 device has migrated, and a device that has not launched
 * since Phase 1 — or one whose migration keeps failing on a corrupt
 * doc (which retries every launch by design) — would lose its old
 * recipes permanently if the dependency went away. The dependency
 * stays until a sunset is decided explicitly: announce the cutoff in
 * a release (so an unmigrated device gets a last chance to run the
 * migration and speak up via migrationFailureNotice), then drop the
 * dependency + this module + the 6 MB precache allowance in the
 * release after that. The cost of keeping it is one lazy WASM chunk
 * (~3.6 MB, fetched only when an old database is present) and the
 * precache limit below.
 *
 * The Automerge dependency is loaded with a dynamic import on purpose: its
 * WASM bundle is only fetched when an old database with actual chunks is
 * present, so users who never ran Phase 0 never pay for it.
 */
import { createRecipe, getOrCreateIndex, getRecipe, listRecipes } from './recipes'
import type { KeyValueStore } from './recipes'
import { getRepo, REPO_DB_NAME } from './repo'
import type { YjsStore } from './repo'
import type { Recipe, RecipeInput } from '../types'

/** localStorage flag: set once the migration has completed (or no-oped). */
export const MIGRATED_KEY = 'longtable:migrated-from-automerge'

/**
 * Flag format version (integrity M14). The v1 flag was an unversioned
 * `{"at", "imported"}` object written even when corrupt docs were
 * silently skipped, so no later run could ever revisit them. A v2
 * flag is `{"version": 2, "at", "imported", "skippedDuplicates"}` and
 * is only written by a run with zero failed documents. A missing or
 * older flag means "run again" (dedupe keeps the re-run from
 * importing anything twice).
 */
export const MIGRATION_FLAG_VERSION = 2

/**
 * localStorage key recording the failed-doc id set the user has
 * already been told about (see migrationFailureNotice). The notice is
 * one-time per set: a repeat launch with the same failures stays
 * quiet, a new failure speaks up.
 */
export const MIGRATION_NOTICED_KEY = 'longtable:migrated-from-automerge:noticed'

/** Object store used by automerge-repo's IndexedDB adapter. */
const OLD_STORE = 'documents'

interface OldChunk {
  docId: string
  type: 'snapshot' | 'incremental'
  hash: string
  data: Uint8Array
}

export interface RecoveredRecipe {
  input: RecipeInput
  createdAt?: string
  updatedAt?: string
  /** Old Automerge document id this recipe came from (for failure records). */
  sourceDocId?: string
}

export interface MigrationOutcome {
  /** True if the scan ran (false when the flag was already set). */
  ran: boolean
  imported: number
  skippedDuplicates: number
  /** Old documents that failed to load or import; they stay orphaned. */
  failedDocs: number
  /**
   * Ids of the old documents that failed to load or import (M14).
   * Empty when the run was clean. Survives in the outcome (and in the
   * user notice) — previously only the count survived, so nobody could
   * tell which documents were lost.
   */
  failedDocIds: string[]
  /**
   * True when the run was clean (no failed documents). Only a clean
   * run sets the completion flag — a failed load or import blocks
   * completion, so the next launch retries.
   */
  complete: boolean
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

/**
 * Open the old Automerge database (if it exists) and read every document
 * chunk. Returns null when there is no old database or no document chunks —
 * the fresh-install case. Never throws for a missing database; real I/O
 * errors propagate so the caller can retry on a later launch.
 *
 * Careful: `indexedDB.open` CREATES an empty database when the name does
 * not exist. If we created it, we delete it again so the app leaves no
 * trace (and future existence checks stay truthful).
 */
async function readOldChunks(dbName: string): Promise<OldChunk[] | null> {
  const openResult = await new Promise<{ db: IDBDatabase; created: boolean }>(
    (resolve, reject) => {
      let created = false
      const req = indexedDB.open(dbName)
      req.onupgradeneeded = () => {
        // Upgrade only fires for a brand-new database — i.e. we created it.
        created = true
      }
      req.onsuccess = () => resolve({ db: req.result, created })
      req.onerror = () => reject(req.error)
    },
  )
  const { db, created } = openResult
  try {
    if (created || !db.objectStoreNames.contains(OLD_STORE)) {
      return null
    }
    const chunks = await new Promise<OldChunk[]>((resolve, reject) => {
      const tx = db.transaction(OLD_STORE, 'readonly')
      const store = tx.objectStore(OLD_STORE)
      const keysReq = store.getAllKeys()
      const valsReq = store.getAll()
      tx.oncomplete = () => {
        const keys = keysReq.result as IDBValidKey[]
        const vals = valsReq.result as unknown[]
        const out: OldChunk[] = []
        for (let i = 0; i < keys.length; i++) {
          const key = keys[i]
          if (!Array.isArray(key) || key.length !== 3) continue
          const [docId, type, hash] = key as unknown[]
          if (typeof docId !== 'string' || typeof hash !== 'string') continue
          if (type !== 'snapshot' && type !== 'incremental') continue
          const value = vals[i] as { binary?: unknown } | undefined
          const binary = value?.binary
          let data: Uint8Array | null = null
          if (binary instanceof Uint8Array) data = binary
          else if (binary instanceof ArrayBuffer) data = new Uint8Array(binary)
          if (data) out.push({ docId, type, hash, data })
        }
        // automerge-repo applied chunks in storage-key order (snapshots and
        // incrementals loaded as separate ranges). Sort deterministically:
        // snapshots first, then incrementals, each by hash (key order).
        out.sort((a, b) => {
          if (a.type !== b.type) return a.type === 'snapshot' ? -1 : 1
          return a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0
        })
        resolve(out)
      }
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error('old db read aborted'))
    })
    return chunks.length > 0 ? chunks : null
  } finally {
    db.close()
    if (created) {
      // We created an empty database just by probing; remove it again.
      await new Promise<void>((resolve) => {
        const del = indexedDB.deleteDatabase(dbName)
        del.onsuccess = () => resolve()
        del.onerror = () => resolve()
        del.onblocked = () => resolve()
      })
    }
  }
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const v of value) {
    if (typeof v !== 'string') return null
    out.push(v)
  }
  return out
}

/**
 * Shape check + extraction: an old document is a recipe iff it has a string
 * title and string-array ingredients and steps. Photos default to [] when
 * absent; optional minute fields are kept only when numeric.
 */
export function asRecoveredRecipe(doc: unknown): RecoveredRecipe | null {
  if (typeof doc !== 'object' || doc === null) return null
  const d = doc as Record<string, unknown>
  if (typeof d.title !== 'string') return null
  const ingredients = stringArray(d.ingredients)
  const steps = stringArray(d.steps)
  if (!ingredients || !steps) return null
  let photos: string[] = []
  if (d.photos !== undefined) {
    const p = stringArray(d.photos)
    if (!p) return null
    photos = p
  }
  const input: RecipeInput = { title: d.title, ingredients, steps, photos }
  if (typeof d.prepMinutes === 'number') input.prepMinutes = d.prepMinutes
  if (typeof d.cookMinutes === 'number') input.cookMinutes = d.cookMinutes
  return {
    input,
    createdAt: typeof d.createdAt === 'string' ? d.createdAt : undefined,
    updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : undefined,
  }
}

/** Content fingerprint used for dedupe (deliberately ignores timestamps). */
export function recipeFingerprint(r: {
  title: string
  ingredients: string[]
  steps: string[]
  photos: string[]
  prepMinutes?: number
  cookMinutes?: number
}): string {
  return JSON.stringify([
    r.title,
    r.ingredients,
    r.steps,
    r.photos,
    r.prepMinutes ?? null,
    r.cookMinutes ?? null,
  ])
}

/**
 * Reconstruct every Automerge document in the old database and return the
 * ones shaped like recipes. `Automerge` is passed in (dynamically imported
 * by the caller) so tests can supply it directly.
 */
export async function recoverOldRecipes(
  chunks: OldChunk[],
  Automerge: typeof import('@automerge/automerge'),
): Promise<{ recipes: RecoveredRecipe[]; failedDocIds: string[] }> {
  const byDoc = new Map<string, OldChunk[]>()
  for (const c of chunks) {
    const arr = byDoc.get(c.docId)
    if (arr) arr.push(c)
    else byDoc.set(c.docId, [c])
  }
  const recipes: RecoveredRecipe[] = []
  const failedDocIds: string[] = []
  for (const [docId, docChunks] of byDoc) {
    try {
      const merged = concatBytes(docChunks.map((c) => c.data))
      const doc = Automerge.loadIncremental(Automerge.init(), merged)
      const recovered = asRecoveredRecipe(doc)
      if (recovered) recipes.push({ ...recovered, sourceDocId: docId })
    } catch {
      // Corrupt or partial chunk set — record the id, keep going.
      failedDocIds.push(docId)
    }
  }
  return { recipes, failedDocIds }
}

/**
 * Run the one-time migration. Safe to call on every launch: the flag makes
 * repeat calls a no-op, and failures before completion leave the flag unset
 * (with dedupe making retries safe). Never throws.
 */
export async function migrateFromAutomergeIfNeeded(
  deps: {
    store?: YjsStore
    kv?: KeyValueStore
    oldDbName?: string
  } = {},
): Promise<MigrationOutcome> {
  const none: MigrationOutcome = {
    ran: false,
    imported: 0,
    skippedDuplicates: 0,
    failedDocs: 0,
    failedDocIds: [],
    complete: false,
  }
  const kv: KeyValueStore = deps.kv ?? localStorage
  try {
    const rawFlag = kv.getItem(MIGRATED_KEY)
    if (rawFlag) {
      try {
        const parsed = JSON.parse(rawFlag) as unknown
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          (parsed as Record<string, unknown>).version === MIGRATION_FLAG_VERSION
        ) {
          return none
        }
      } catch {
        // Unparseable flag — fall through and run; a clean run rewrites it.
      }
      // A flag without the current version is a pre-v2 completion: the
      // old run may have silently dropped corrupt docs, so run again
      // under the v2 rules (dedupe keeps it from importing twice).
    }
  } catch {
    // localStorage unavailable (private mode etc.) — proceed without the
    // flag; dedupe still prevents duplicate imports.
  }
  let outcome: MigrationOutcome
  let complete: boolean
  try {
    ;({ outcome, complete } = await runMigration(
      deps.store ?? getRepo(),
      kv,
      deps.oldDbName ?? REPO_DB_NAME,
    ))
  } catch (e) {
    console.warn('[longtable] Automerge migration failed; will retry next launch:', e)
    return none
  }
  if (complete) {
    try {
      kv.setItem(
        MIGRATED_KEY,
        JSON.stringify({
          version: MIGRATION_FLAG_VERSION,
          at: new Date().toISOString(),
          imported: outcome.imported,
          skippedDuplicates: outcome.skippedDuplicates,
        }),
      )
    } catch {
      // Flag could not be persisted; dedupe keeps the next run harmless.
    }
  }
  return outcome
}

/**
 * One-time user notice for a migration run with failed documents
 * (M14). Returns the plain-language notice the app should show, or
 * null when there is nothing to say (no run, no failures, or this
 * exact failed-doc set was already told about — the notice is
 * one-time per set, so a repeat launch with the same corrupt docs
 * stays quiet while a NEW failure speaks up). The set is recorded in
 * `kv` under MIGRATION_NOTICED_KEY.
 */
export function migrationFailureNotice(
  outcome: MigrationOutcome,
  kv: KeyValueStore = localStorage,
): string | null {
  if (!outcome.ran || outcome.failedDocIds.length === 0) return null
  const key = [...outcome.failedDocIds].sort().join(',')
  try {
    if (kv.getItem(MIGRATION_NOTICED_KEY) === key) return null
    kv.setItem(MIGRATION_NOTICED_KEY, key)
  } catch {
    // Notice record could not be persisted — still show it this once.
  }
  const n = outcome.failedDocIds.length
  return (
    `The old cookbook recovery couldn't read ${n} recipe${n === 1 ? '' : 's'} ` +
    `from the previous format, so ${n === 1 ? 'it was' : 'they were'} left out. ` +
    'Your current recipes are unaffected, and the old data is still kept on this device.'
  )
}

async function runMigration(
  store: YjsStore,
  kv: KeyValueStore,
  oldDbName: string,
): Promise<{ outcome: MigrationOutcome; complete: boolean }> {
  const chunks = await readOldChunks(oldDbName)
  if (!chunks) {
    // No Phase 0 database (fresh install or already-clean device).
    return {
      outcome: {
        ran: true,
        imported: 0,
        skippedDuplicates: 0,
        failedDocs: 0,
        failedDocIds: [],
        complete: true,
      },
      complete: true,
    }
  }
  // Only pay for the Automerge WASM when there is something to recover.
  const Automerge = await import('@automerge/automerge')
  const { recipes: recovered, failedDocIds: loadFailed } = await recoverOldRecipes(
    chunks,
    Automerge,
  )

  const index = await getOrCreateIndex(store, kv)
  const fingerprints = new Set<string>()
  for (const summary of await listRecipes(index)) {
    const existing = await getRecipe(store, summary.url)
    if (existing) fingerprints.add(recipeFingerprint(existing as Recipe))
  }

  let imported = 0
  let skippedDuplicates = 0
  const failedImportIds: string[] = []
  for (const rec of recovered) {
    const fp = recipeFingerprint(rec.input)
    if (fingerprints.has(fp)) {
      skippedDuplicates += 1
      continue
    }
    try {
      await createRecipe(store, index, rec.input, {
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
      })
      fingerprints.add(fp)
      imported += 1
    } catch (e) {
      console.warn('[longtable] failed to import a recovered recipe:', e)
      if (rec.sourceDocId) failedImportIds.push(rec.sourceDocId)
    }
  }
  // Integrity M14: ANY failed document — a corrupt chunk set that
  // could not load, or a recovered recipe that could not import —
  // blocks completion, so the flag stays unset and the next launch
  // retries. The failed ids are recorded (previously only a count
  // survived) and the user is told once per set (see
  // migrationFailureNotice). A permanently corrupt doc means the run
  // retries every launch; that is the honest cost of not silently
  // dropping it, and dedupe keeps each retry from importing twice.
  const failedDocIds = [...loadFailed, ...failedImportIds]
  const complete = failedDocIds.length === 0
  return {
    outcome: {
      ran: true,
      imported,
      skippedDuplicates,
      failedDocs: failedDocIds.length,
      failedDocIds,
      complete,
    },
    complete,
  }
}
