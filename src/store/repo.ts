import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

export const REPO_DB_NAME = 'longtable'

/** Guid of the dedicated recipe-index document (stable across sessions). */
export const INDEX_GUID = 'longtable-index'

const URL_SCHEME = 'yjs:'
const FLUSH_KEY = '__longtable_flush__'
/**
 * Stable per-device Yjs clientID (persisted in localStorage).
 * Yjs assigns a random clientID to each new Doc; without stability, an edit
 * made after an app restart gets clock 0 under a fresh clientID and can LOSE
 * a conflict against the pre-restart item (same clock 0, higher old clientID).
 * A stable clientID keeps the Lamport clock monotonic across launches.
 */
const CLIENT_ID_KEY = 'longtable:client-id'

/** This device's stable Yjs clientID, generated once and persisted. */
export function getDeviceClientId(): number {
  try {
    const raw = localStorage.getItem(CLIENT_ID_KEY)
    if (raw) {
      const n = parseInt(raw, 10)
      if (Number.isSafeInteger(n) && n > 0) return n
    }
  } catch { /* storage unavailable — fall through to ephemeral */ }
  const n = 1 + Math.floor(Math.random() * 0xffffffff)
  try {
    localStorage.setItem(CLIENT_ID_KEY, String(n))
  } catch { /* ignore */ }
  return n
}

/** One cached Yjs document: the live doc plus its IndexedDB persistence. */
export interface YjsDocEntry {
  doc: Y.Doc
  persistence: IndexeddbPersistence
}

/**
 * Yjs store container (replaces the Automerge `Repo`).
 *
 * One IndexedDB database per document: y-indexeddb's `updates` object store
 * is shared per database, so documents sharing a database would replay each
 * other's updates into themselves, and a deleted document's data could never
 * be removed without wiping the others. Database names derive from `dbName`:
 * `<dbName>:index` for the recipe index, `<dbName>:recipe:<guid>` per recipe.
 */
export interface YjsStore {
  readonly dbName: string
  readonly docs: Map<string, YjsDocEntry>
  readonly pending: Map<string, Promise<Y.Doc>>
  /**
   * Await until every cached document's pending IndexedDB writes have
   * committed. A readonly transaction on the same connection is ordered
   * after all previously issued writes, so awaiting it proves they landed.
   */
  flush(): Promise<void>
}

let store: YjsStore | undefined

/**
 * App-wide store singleton. One Y.Doc per recipe, persisted to IndexedDB.
 * Phase 1: still purely local — P2P sync arrives separately.
 */
export function getRepo(): YjsStore {
  if (!store) {
    store = createRepo()
  }
  return store
}

/** Create a store instance against the given IndexedDB database namespace. */
export function createRepo(dbName: string = REPO_DB_NAME): YjsStore {
  const docs = new Map<string, YjsDocEntry>()
  const pending = new Map<string, Promise<Y.Doc>>()
  return {
    dbName,
    docs,
    pending,
    async flush(): Promise<void> {
      await Promise.all(
        [...docs.values()].map(async ({ persistence }) => {
          const p = await persistence.whenSynced
          await p.get(FLUSH_KEY)
        }),
      )
    },
  }
}

/** Test hook: drop the singleton so tests can build isolated instances. */
export function resetRepoForTests(): void {
  if (store) {
    for (const { persistence } of store.docs.values()) {
      void persistence.destroy().catch(() => undefined)
    }
    store = undefined
  }
}

/** Document URL for a doc guid: `yjs:<guid>`. */
export function docUrl(guid: string): string {
  return `${URL_SCHEME}${guid}`
}

/** Parse a `yjs:<guid>` URL; null for anything else. */
export function guidFromUrl(url: string): string | null {
  return url.startsWith(URL_SCHEME) ? url.slice(URL_SCHEME.length) : null
}

/** IndexedDB database name for a document. */
export function docDbName(dbName: string, guid: string): string {
  return guid === INDEX_GUID ? `${dbName}:index` : `${dbName}:recipe:${guid}`
}

/**
 * Load (or create) the Y.Doc for `guid`, awaiting its IndexedDB sync before
 * returning. Concurrent callers share a single load.
 *
 * IMPORTANT: y-indexeddb silently drops updates that arrive before its
 * IndexedDB connection opens, so the doc must not be touched before the
 * returned promise resolves.
 */
export async function getOrCreateDoc(store: YjsStore, guid: string): Promise<Y.Doc> {
  const cached = store.docs.get(guid)
  if (cached) return cached.doc
  let p = store.pending.get(guid)
  if (!p) {
    p = (async (): Promise<Y.Doc> => {
      const doc = new Y.Doc({ guid })
      const persistence = new IndexeddbPersistence(docDbName(store.dbName, guid), doc)
      try {
        await persistence.whenSynced
        // Stable clientID: without this, edits after a restart get clock 0
        // under a fresh random clientID and can lose conflicts against the
        // pre-restart item (same clock 0, higher old clientID).
        // MUST be set AFTER whenSynced: y-indexeddb replays stored updates as
        // remote transactions, and Yjs changes the clientID if a remote
        // transaction touches the doc's own clientID. After load, the store
        // knows this client's clock, so edits continue monotonically.
        doc.clientID = getDeviceClientId()
        store.docs.set(guid, { doc, persistence })
        return doc
      } catch (e) {
        await persistence.destroy().catch(() => undefined)
        throw e
      } finally {
        store.pending.delete(guid)
      }
    })()
    store.pending.set(guid, p)
  }
  return p
}
