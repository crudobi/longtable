import * as Y from 'yjs'
import { INDEX_GUID, docUrl, getOrCreateDoc, getRepo, guidFromUrl } from './repo'
import type { YjsStore } from './repo'
import type {
  Recipe,
  RecipeIndexDoc,
  RecipeInput,
  RecipePatch,
  RecipeSummary,
} from '../types'

const INDEX_URL_KEY = 'longtable:recipe-index-url'
export const RECIPE_MAP = 'recipe'
const INDEX_MAP = 'recipes'

/** Minimal key/value store (localStorage in the app, in-memory in tests). */
export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function memoryStore(): KeyValueStore {
  const map = new Map<string, string>()
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v)
    },
  }
}

/**
 * Opaque handle for the recipe index document (replaces Automerge's
 * `DocHandle<RecipeIndexDoc>`). `doc()` returns a plain-object snapshot —
 * Yjs types never leak to callers.
 */
export interface IndexHandle {
  /** Stable URL of the index document (`yjs:longtable-index`). */
  url: string
  doc(): Promise<RecipeIndexDoc | null>
}

interface IndexEntry {
  title: string
  url: string
  updatedAt: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function strArray(items: string[]): Y.Array<string> {
  const arr = new Y.Array<string>()
  arr.push(items)
  return arr
}

/**
 * Build a nested Y.Map for an index entry. (Yjs does NOT auto-convert plain
 * objects set as map values — they land as inert `Object`s — so the Y.Map
 * must be constructed explicitly for the entry to be a real CRDT map.)
 */
function entryMap(entry: IndexEntry): Y.Map<unknown> {
  const m = new Y.Map<unknown>()
  m.set('title', entry.title)
  m.set('url', entry.url)
  m.set('updatedAt', entry.updatedAt)
  return m
}

function toStringArray(value: unknown): string[] {
  if (value instanceof Y.Array) {
    return (value.toArray() as unknown[]).filter(
      (x): x is string => typeof x === 'string',
    )
  }
  return []
}

function replaceArray(map: Y.Map<any>, key: string, items: string[]): void {
  const cur = map.get(key)
  if (cur instanceof Y.Array) {
    // If the content is identical, do nothing: delete+push would mint new
    // Yjs item IDs for the same strings, which breaks concurrent merge
    // (a peer holding the old IDs would see duplicates after sync).
    const current = cur.toArray() as string[]
    if (current.length === items.length && current.every((v, i) => v === items[i])) {
      return
    }
    cur.delete(0, cur.length)
    cur.push(items)
  } else {
    map.set(key, strArray(items))
  }
}

function snapshotIndex(doc: Y.Doc): RecipeIndexDoc {
  const recipes: Record<string, IndexEntry> = {}
  doc.getMap(INDEX_MAP).forEach((raw, id) => {
    if (raw instanceof Y.Map) {
      const e = raw.toJSON() as IndexEntry
      if (
        typeof e.title === 'string' &&
        typeof e.url === 'string' &&
        typeof e.updatedAt === 'string'
      ) {
        recipes[id] = { title: e.title, url: e.url, updatedAt: e.updatedAt }
      }
    }
  })
  return { recipes }
}

/**
 * Load the dedicated index document (recipe list -> doc URLs), creating it on
 * first run. The index URL itself is kept in the provided key/value store.
 */
export async function getOrCreateIndex(
  repo: YjsStore = getRepo(),
  kv: KeyValueStore = localStorage,
): Promise<IndexHandle> {
  const url = docUrl(INDEX_GUID)
  if (!kv.getItem(INDEX_URL_KEY)) {
    kv.setItem(INDEX_URL_KEY, url)
  }
  const doc = await getOrCreateDoc(repo, INDEX_GUID)
  return {
    url,
    doc: async () => snapshotIndex(doc),
  }
}

/** Create one Y.Doc for the recipe and register it in the index. */
export async function createRecipe(
  repo: YjsStore,
  // Named for call-shape compatibility; the index doc is resolved from the
  // store (its guid is deterministic), so the handle itself is not needed here.
  _index: IndexHandle,
  input: RecipeInput,
  // Optional preserved timestamps (used by the Phase 0 recovery migration so
  // an imported recipe keeps its original created/updated times). Defaults
  // to "now" for normal creation.
  timestamps?: { createdAt?: string; updatedAt?: string },
): Promise<RecipeSummary> {
  const id = crypto.randomUUID()
  const createdAt = timestamps?.createdAt ?? nowIso()
  const updatedAt = timestamps?.updatedAt ?? createdAt
  // Fresh UUID: the document cannot already exist in IndexedDB.
  const doc = await getOrCreateDoc(repo, id)
  doc.transact(() => {
    const map = doc.getMap(RECIPE_MAP)
    map.set('title', input.title)
    map.set('ingredients', strArray(input.ingredients))
    map.set('steps', strArray(input.steps))
    map.set('photos', strArray(input.photos))
    map.set('createdAt', createdAt)
    map.set('updatedAt', updatedAt)
    if (input.visibility !== undefined) map.set('visibility', input.visibility)
    // Only set optional fields when present.
    if (input.prepMinutes !== undefined) map.set('prepMinutes', input.prepMinutes)
    if (input.cookMinutes !== undefined) map.set('cookMinutes', input.cookMinutes)
  })

  const url = docUrl(id)
  const summary: RecipeSummary = { id, title: input.title, url, updatedAt }
  const indexDoc = await getOrCreateDoc(repo, INDEX_GUID)
  indexDoc.transact(() => {
    indexDoc
      .getMap(INDEX_MAP)
      .set(id, entryMap({ title: input.title, url, updatedAt }))
  })
  return summary
}

/**
 * Register a recipe received via P2P share in the local index so it appears
 * in the list. The document content itself arrives via Yjs sync; this only
 * adds the index entry. Idempotent — a second join is a no-op.
 */
export async function registerSharedRecipe(
  repo: YjsStore,
  id: string,
  title: string,
): Promise<void> {
  const url = docUrl(id)
  const updatedAt = new Date().toISOString()
  const indexDoc = await getOrCreateDoc(repo, INDEX_GUID)
  indexDoc.transact(() => {
    const map = indexDoc.getMap(INDEX_MAP)
    if (!map.has(id)) {
      map.set(id, entryMap({ title, url, updatedAt }))
    }
  })
}

/** List all recipes (newest first) from the index document. */
export async function listRecipes(index: IndexHandle): Promise<RecipeSummary[]> {
  const snap = await index.doc()
  if (!snap) return []
  return Object.entries(snap.recipes)
    .map(([id, entry]) => ({
      id,
      title: entry.title,
      url: entry.url,
      updatedAt: entry.updatedAt,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** Load a full recipe document by its `yjs:` URL. Returns a plain object. */
export async function getRecipe(repo: YjsStore, url: string): Promise<Recipe | null> {
  const guid = guidFromUrl(url)
  if (!guid) return null
  const doc = await getOrCreateDoc(repo, guid)
  const map = doc.getMap(RECIPE_MAP)
  const title = map.get('title')
  // A missing title means the document holds no recipe (e.g. deleted).
  if (typeof title !== 'string') return null
  const createdAt = map.get('createdAt')
  const updatedAt = map.get('updatedAt')
  return {
    title,
    ingredients: toStringArray(map.get('ingredients')),
    steps: toStringArray(map.get('steps')),
    photos: toStringArray(map.get('photos')),
    createdAt: typeof createdAt === 'string' ? createdAt : '',
    updatedAt: typeof updatedAt === 'string' ? updatedAt : '',
    ...(map.get('visibility') === 'friends-only'
      ? { visibility: 'friends-only' as const }
      : map.get('visibility') === 'public'
        ? { visibility: 'public' as const }
        : {}),
    ...(map.has('prepMinutes') ? { prepMinutes: map.get('prepMinutes') as number } : {}),
    ...(map.has('cookMinutes') ? { cookMinutes: map.get('cookMinutes') as number } : {}),
  }
}

/** Patch a recipe document and refresh its index entry. */
export async function updateRecipe(
  repo: YjsStore,
  index: IndexHandle,
  id: string,
  patch: RecipePatch,
): Promise<void> {
  const snap = await index.doc()
  const entry = snap?.recipes[id]
  if (!entry) throw new Error(`recipe not found: ${id}`)

  const doc = await getOrCreateDoc(repo, guidFromUrl(entry.url) ?? id)
  const updatedAt = nowIso()
  doc.transact(() => {
    const map = doc.getMap(RECIPE_MAP)
    if (patch.title !== undefined) map.set('title', patch.title)
    if ('visibility' in patch) {
      if (patch.visibility === undefined || patch.visibility === 'private') {
        map.delete('visibility')
      } else {
        map.set('visibility', patch.visibility)
      }
    }
    if (patch.ingredients !== undefined) replaceArray(map, 'ingredients', patch.ingredients)
    if (patch.steps !== undefined) replaceArray(map, 'steps', patch.steps)
    if (patch.photos !== undefined) replaceArray(map, 'photos', patch.photos)
    // Optional fields are only touched when the patch explicitly mentions them,
    // so a partial patch never clobbers them; explicit `undefined` clears.
    if ('prepMinutes' in patch) {
      if (patch.prepMinutes === undefined) {
        map.delete('prepMinutes')
      } else {
        map.set('prepMinutes', patch.prepMinutes)
      }
    }
    if ('cookMinutes' in patch) {
      if (patch.cookMinutes === undefined) {
        map.delete('cookMinutes')
      } else {
        map.set('cookMinutes', patch.cookMinutes)
      }
    }
    map.set('updatedAt', updatedAt)
  })
  const indexDoc = await getOrCreateDoc(repo, INDEX_GUID)
  indexDoc.transact(() => {
    indexDoc.getMap(INDEX_MAP).set(
      id,
      entryMap({
        title: patch.title !== undefined ? patch.title : entry.title,
        url: entry.url,
        updatedAt,
      }),
    )
  })
}

/**
 * Remove a recipe from the index and wipe its Y.Doc from IndexedDB so it no
 * longer loads. Other recipes are untouched.
 */
export async function deleteRecipe(
  repo: YjsStore,
  index: IndexHandle,
  id: string,
): Promise<void> {
  const snap = await index.doc()
  const entry = snap?.recipes[id]
  if (!entry) return
  const indexDoc = await getOrCreateDoc(repo, INDEX_GUID)
  indexDoc.transact(() => {
    indexDoc.getMap(INDEX_MAP).delete(id)
  })
  const guid = guidFromUrl(entry.url)
  if (!guid) return
  // Ensure the doc is loaded so we hold its persistence, then destroy the
  // persistence and delete the doc's IndexedDB database.
  await getOrCreateDoc(repo, guid)
  const cached = repo.docs.get(guid)
  repo.docs.delete(guid)
  repo.pending.delete(guid)
  if (cached) {
    await cached.persistence.clearData()
  }
}
