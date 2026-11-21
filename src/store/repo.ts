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
  /**
   * Null in degraded mode (L-N3): IndexedDB failed, so this doc lives
   * in memory only. flush() skips null entries; nothing is persisted.
   */
  persistence: IndexeddbPersistence | null
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
 * L-N3 degraded mode (process-global): once any document's IndexedDB
 * persistence fails (quota exceeded, IndexedDB unavailable or blocked),
 * every document in this process is in-memory only. The flag is sticky
 * for the process — re-trying a dead IndexedDB per document would only
 * repeat the failure and its delay — and a reload re-attempts it. The
 * app reads isPersistenceDegraded() at startup and shows the banner
 * (App.tsx) so the user knows this session's edits will not survive.
 */
let persistenceDegraded = false
let persistenceErrorMessage: string | null = null

/** True once IndexedDB persistence has failed in this process. */
export function isPersistenceDegraded(): boolean {
  return persistenceDegraded
}

/** The first persistence failure's message (no stored data in it), if any. */
export function getPersistenceErrorMessage(): string | null {
  return persistenceErrorMessage
}

function markPersistenceDegraded(e: unknown): void {
  if (!persistenceDegraded) {
    console.warn(
      '[longtable] IndexedDB persistence failed — running in-memory only for this session; ' +
        'edits will not survive a reload:',
      e instanceof Error ? e.message : String(e),
    )
  }
  persistenceDegraded = true
  if (persistenceErrorMessage === null) {
    persistenceErrorMessage = e instanceof Error ? e.message : String(e)
  }
}

/** Test hook: clear the degraded flag between tests in one file. */
export function resetPersistenceStateForTests(): void {
  persistenceDegraded = false
  persistenceErrorMessage = null
  probeOutcome = null
}

/** Result of the IndexedDB probe: ok, or the failure that proves it dead. */
interface IndexedDbProbe {
  ok: boolean
  error?: unknown
}

/**
 * How long the IndexedDB probe waits for an open that never answers
 * (a blocked open can hang indefinitely) before calling it dead.
 */
const PROBE_TIMEOUT_MS = 5000

/** Cached probe outcome for this process (cleared by resetPersistenceStateForTests). */
let probeOutcome: Promise<IndexedDbProbe> | null = null

/**
 * Open a throwaway probe database to learn whether IndexedDB works at
 * all in this process, BEFORE constructing any y-indexeddb persistence
 * (see getOrCreateDoc). The probe database is deleted again on success.
 * Never throws; a failure is a value. The probe runs at most once per
 * process — a working IndexedDB is not re-probed per document, and a
 * dead one flips the process into degraded mode anyway.
 */
function probeIndexedDb(dbName: string): Promise<IndexedDbProbe> {
  if (!probeOutcome) probeOutcome = runIndexedDbProbe(dbName)
  return probeOutcome
}

function runIndexedDbProbe(dbName: string): Promise<IndexedDbProbe> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve({ ok: false, error: new Error('IndexedDB is not available') })
      return
    }
    let done = false
    const finish = (result: IndexedDbProbe) => {
      if (done) return
      done = true
      resolve(result)
    }
    const timer = setTimeout(
      () => finish({ ok: false, error: new Error('IndexedDB open timed out') }),
      PROBE_TIMEOUT_MS,
    )
    // Do not hold the test/node process open on the probe timer.
    const maybeUnref = timer as unknown as { unref?: () => void }
    if (typeof maybeUnref.unref === 'function') maybeUnref.unref()
    const probeName = `${dbName}:probe`
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(probeName, 1)
    } catch (e) {
      clearTimeout(timer)
      finish({ ok: false, error: e })
      return
    }
    req.onsuccess = () => {
      clearTimeout(timer)
      try {
        req.result.close()
      } catch {
        /* ignore */
      }
      try {
        indexedDB.deleteDatabase(probeName)
      } catch {
        /* best-effort cleanup of the throwaway probe database */
      }
      finish({ ok: true })
    }
    req.onerror = () => {
      clearTimeout(timer)
      finish({ ok: false, error: req.error ?? new Error('IndexedDB open failed') })
    }
    // onblocked: another connection holds the probe DB — the timeout
    // above decides; do not resolve early either way.
    req.onblocked = () => undefined
  })
}

/** A fresh in-memory doc: no persistence binding, stable clientID set now. */
function newInMemoryDoc(guid: string): Y.Doc {
  const doc = new Y.Doc({ guid })
  // No IndexedDB replay to wait for, so the clientID can be set
  // immediately (the persisted path sets it after whenSynced instead).
  doc.clientID = getDeviceClientId()
  return doc
}

/**
 * App-wide store singleton. One Y.Doc per recipe, persisted to IndexedDB.
 * Sync providers (P2P share rooms, friend channels) attach to these docs
 * from src/p2p and src/friends; the store itself stays a local container.
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
          if (!persistence) return
          const p = await persistence.whenSynced
          await p.get(FLUSH_KEY)
        }),
      )
    },
  }
}

/**
 * Flush pending IndexedDB writes when the page is being hidden or
 * unloaded (integrity M12: flush() existed but had zero callers, so a
 * kill right after a mutation could lose the write even though the
 * in-memory doc held it). Best-effort: pagehide gives no time to
 * await, so failures are logged, not thrown. Returns an unsubscribe
 * function. No-op where there is no window (tests running in node).
 */
export function registerPagehideFlush(store: YjsStore): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return () => undefined
  }
  const onPagehide = () => {
    void store.flush().catch((e) => {
      console.warn('[longtable] pagehide flush failed; writes may be lost:', e)
    })
  }
  window.addEventListener('pagehide', onPagehide)
  return () => window.removeEventListener('pagehide', onPagehide)
}

/** Test hook: drop the singleton so tests can build isolated instances. */
export function resetRepoForTests(): void {
  if (store) {
    for (const { persistence } of store.docs.values()) {
      if (persistence) void persistence.destroy().catch(() => undefined)
    }
    store = undefined
  }
}

/** Document URL for a doc guid: `yjs:<guid>`. */
export function docUrl(guid: string): string {
  return `${URL_SCHEME}${guid}`
}

/**
 * Drop a cached document and wipe its IndexedDB database (Rel L5
 * residual): a join that created the doc and then failed must leave
 * no orphaned doc behind. No-op when the doc was never loaded.
 * Never call on a doc that holds the user's own content — the caller
 * must have established the doc is join-created (fresh join, no
 * pre-existing share record). Mirrors deleteRecipe's wipe, minus the
 * index removal (an orphaned join doc has no index entry).
 */
export async function dropDoc(store: YjsStore, guid: string): Promise<void> {
  const cached = store.docs.get(guid)
  store.docs.delete(guid)
  store.pending.delete(guid)
  if (cached?.persistence) {
    // Null in degraded mode (L-N3): an in-memory doc has no
    // IndexedDB database to wipe, so there is nothing to clear.
    await cached.persistence.clearData()
  }
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
 *
 * L-N3: when IndexedDB persistence fails (quota exceeded, IndexedDB
 * unavailable or blocked), this does NOT throw. Every store call goes
 * through here, so throwing made the whole app unusable; instead the
 * doc is created in memory (persistence: null), the process flips into
 * degraded mode, and the app banner says the session's edits will not
 * survive a reload. Reads, edits, shares, and friends channels all keep
 * working in memory for this session.
 */
export async function getOrCreateDoc(store: YjsStore, guid: string): Promise<Y.Doc> {
  const cached = store.docs.get(guid)
  if (cached) return cached.doc
  let p = store.pending.get(guid)
  if (!p) {
    p = (async (): Promise<Y.Doc> => {
      try {
        // Already degraded: do not re-attempt a dead IndexedDB.
        if (persistenceDegraded) {
          const memDoc = newInMemoryDoc(guid)
          store.docs.set(guid, { doc: memDoc, persistence: null })
          return memDoc
        }
        // Probe first (L-N3): y-indexeddb's whenSynced NEVER rejects —
        // a failed open leaves it pending forever while the library's
        // own .then on the failed open leaks an unhandled rejection.
        // Probing with our own open (with handlers + timeout) is the
        // only way to learn IndexedDB is dead BEFORE constructing the
        // persistence, so the failure stays a clean fallback.
        const probe = await probeIndexedDb(store.dbName)
        if (!probe.ok) {
          markPersistenceDegraded(
            probe.error ?? new Error('IndexedDB could not be opened'),
          )
          const memDoc = newInMemoryDoc(guid)
          store.docs.set(guid, { doc: memDoc, persistence: null })
          return memDoc
        }
        const doc = new Y.Doc({ guid })
        let persistence: IndexeddbPersistence | null = null
        try {
          persistence = new IndexeddbPersistence(docDbName(store.dbName, guid), doc)
          // Defense in depth for a failure between the probe and this
          // open (e.g. quota hit in between): race whenSynced against
          // the persistence's own open promise, which DOES reject.
          // (Accessing the private _db is pinned to this y-indexeddb
          // version; the race is skipped if the shape ever changes.)
          const dbReady = (persistence as unknown as { _db?: Promise<unknown> })._db
          if (dbReady && typeof dbReady.then === 'function') {
            await Promise.race([
              persistence.whenSynced,
              dbReady.then(() => new Promise<never>(() => undefined)),
            ])
          } else {
            await persistence.whenSynced
          }
        } catch (e) {
          // Persistence failed — fall back to an in-memory doc (see the
          // header comment). The bound doc is discarded with the failed
          // persistence; the in-memory replacement is a fresh doc.
          await persistence?.destroy().catch(() => undefined)
          markPersistenceDegraded(e)
          const memDoc = newInMemoryDoc(guid)
          store.docs.set(guid, { doc: memDoc, persistence: null })
          return memDoc
        }
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
      } finally {
        store.pending.delete(guid)
      }
    })()
    store.pending.set(guid, p)
  }
  return p
}
